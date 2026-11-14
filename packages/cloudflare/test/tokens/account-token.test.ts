import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  NodeDurableRuntime,
  runDurableWorkflow,
  runWithSecretContext,
} from "@notation/core";
import {
  createPlan,
  createResourceRegistry,
  type ReconcilerEvent,
} from "@notation/reconciler";
import * as durable from "@notation/reconciler/durable";
import { collectResourceGraph } from "@notation/resource";
import { SecretsStore, SecretsStoreSecret } from "src/resources/secrets-store";
import { AccountToken } from "src/resources/tokens";
import { accountToken } from "src/tokens";
import type { BindableSecret } from "src/workers/declaration";
import { FakeBinding, operations } from "../fake-producer";

const NAME = "shop--dev--deploy";
const SECRETS = "/client/v4/accounts/acc/secrets_store/stores/st/secrets";
const TOKENS = "/client/v4/accounts/acc/tokens";
let directory: string;
let runtime: NodeDurableRuntime;
let events: ReconcilerEvent[];
let secrets: Map<string, { id: string; value: string }>;
let tokens: Map<string, { name: string; value: string }>;
// The requests that change something, as `METHOD path`.
let writes: string[];
let created: number;

const fail = (status: number, code: number, message: string) =>
  Response.json(
    { success: false, errors: [{ code, message }], result: null },
    { status },
  );
const ok = (result: unknown) =>
  Response.json({ success: true, errors: [], result });

// The Secrets Store and API token APIs of one account with one store.
function fakeCloudflare() {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const route = url.pathname;
    if (method !== "GET") writes.push(`${method} ${route}`);
    if (route === `${TOKENS}/permission_groups`) {
      return ok([
        {
          id: "g1",
          name: url.searchParams.get("name"),
          scopes: ["com.cloudflare.api.account"],
        },
      ]);
    }
    if (route === TOKENS && method === "POST") {
      created += 1;
      const id = `t${created}`;
      const value = `token-value-${created}`;
      tokens.set(id, { name: body.name, value });
      return ok({ id, value });
    }
    if (route === TOKENS && method === "GET") {
      return ok([...tokens].map(([id, { name }]) => ({ id, name })));
    }
    const token = route.match(/^\/client\/v4\/accounts\/acc\/tokens\/(.+)$/);
    if (token) {
      const found = tokens.get(token[1]!);
      if (!found) return fail(404, 1003, "Invalid API Token");
      if (method === "DELETE") tokens.delete(token[1]!);
      return ok({
        id: token[1],
        name: found.name,
        policies: [
          {
            id: "p1",
            effect: "allow",
            permission_groups: [{ id: "g1" }],
            resources: { "com.cloudflare.api.account.acc": "*" },
          },
        ],
      });
    }
    const stores = "/client/v4/accounts/acc/secrets_store/stores";
    if (route === stores) return ok([{ id: "st", name: "s" }]);
    if (route === `${stores}/st`) return ok({ id: "st", name: "s" });
    if (route === SECRETS && method === "GET") {
      return ok(
        [...secrets].map(([name, { id }]) => ({ id, name, status: "active" })),
      );
    }
    if (route === SECRETS && method === "POST") {
      const [{ name, value }] = body;
      secrets.set(name, { id: `id-${name}`, value });
      return ok([{ id: `id-${name}`, name, status: "active" }]);
    }
    const one = route.match(/\/secrets\/id-(.+)$/);
    if (one && method === "PATCH") {
      secrets.set(one[1]!, { id: `id-${one[1]}`, value: body.value });
      return ok({ id: `id-${one[1]}` });
    }
    if (one && method === "DELETE") {
      secrets.delete(one[1]!);
      return ok(null);
    }
    return fail(400, 1001, `unexpected ${method} ${url.pathname}`);
  });
}

const policies = [
  {
    effect: "allow" as const,
    permissionGroups: ["Workers Scripts Write"],
    resources: { "com.cloudflare.api.account.acc": "*" },
  },
];

// A Worker-like resource that binds the secret, as `secretsStore.bind` does.
const bind = (bindable: BindableSecret) => {
  const target = bindable["~secret"]();
  return new FakeBinding("binding:api", {
    config: {
      Id: "api",
      StoreId: target.outputRef("StoreId"),
      SecretName: target.outputRef("Name"),
    },
  });
};

const after = () => {
  bind(accountToken({ id: "deploy", policies }));
};

const collect = (evaluate: () => void) =>
  collectResourceGraph(evaluate, { scope: { app: "shop", stage: "dev" } });

const registry = createResourceRegistry([
  AccountToken,
  FakeBinding,
  SecretsStoreSecret,
  SecretsStore,
]);

function run(
  workflow: "deploy" | "destroy",
  executionId: string,
  evaluate: () => void,
  prompt?: () => Promise<string>,
) {
  return runWithSecretContext(
    { stage: "dev", runId: executionId, prompt },
    async () => {
      const { resources } = await collect(evaluate);
      const opts = {
        executionId,
        resources,
        state: runtime.state,
        registry,
        nameScope: { app: "test", stage: "dev" },
        emit: (event: ReconcilerEvent) => {
          events.push(event);
        },
      };
      await runDurableWorkflow(
        { workflowId: workflow, runtime, executionId },
        (step, id) =>
          workflow === "deploy"
            ? durable.deploy(step, { ...opts, executionId: id })
            : durable.destroy(step, { ...opts, executionId: id }),
      );
    },
  );
}

const deploy = (
  executionId: string,
  evaluate: () => void,
  prompt?: () => Promise<string>,
) => run("deploy", executionId, evaluate, prompt);

function plan(evaluate: () => void) {
  return runWithSecretContext({ stage: "dev", runId: "plan" }, async () => {
    const { resources } = await collect(evaluate);
    return createPlan({
      resources,
      state: runtime.state,
      driftDetection: true,
    });
  });
}

const decisions = (planned: Awaited<ReturnType<typeof plan>>) =>
  Object.fromEntries(planned.nodes.map((node) => [node.id, node.decision]));

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "notation-cf-token-"));
  runtime = new NodeDurableRuntime({
    deployment: { app: "shop", stage: "dev" },
    databasePath: path.join(directory, "workflows.db"),
  });
  events = [];
  secrets = new Map();
  tokens = new Map();
  writes = [];
  created = 0;
  operations.length = 0;
  vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "acc");
  vi.stubEnv("CLOUDFLARE_API_TOKEN", "token");
  fakeCloudflare();
});

afterEach(async () => {
  runtime.close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

describe("accountToken in a deploy", () => {
  it("creates the store, the token, then the secret that holds its value", async () => {
    await deploy("first", after);

    expect(
      events.flatMap((event) =>
        event.event === "reconciler.operation.lifecycle" &&
        event.operation === "create" &&
        event.status === "success"
          ? [event.resourceId]
          : [],
      ),
    ).toEqual([
      "secrets-store",
      "token:deploy",
      "secret:deploy",
      "binding:api",
    ]);
    expect(secrets.get(NAME)?.value).toBe("token-value-1");
    expect((await runtime.state.get("token:deploy"))?.params).toEqual({
      AccountId: "acc",
      Name: NAME,
      Policies: [{ ...policies[0], permissionGroups: ["g1"] }],
      ValueTarget: {
        provider: "@notation/cloudflare/resources",
        params: { AccountId: "acc", StoreId: "st", Name: NAME },
      },
    });
    expect(JSON.stringify(await runtime.state.values())).not.toContain(
      "token-value-1",
    );
    expect(decisions(await plan(after))).toEqual({
      "secrets-store": "noop",
      "token:deploy": "noop",
      "secret:deploy": "noop",
      "binding:api": "noop",
    });
  });

  describe.each([
    ["present", false],
    ["missing", true],
  ])(
    "rotates the token when it is deleted in the dashboard, with the secret %s",
    (_, secretMissing) => {
      it("plans the token's create as a rotation, and one deploy writes a new value to the secret", async () => {
        await deploy("first", after);
        tokens.delete("t1");
        if (secretMissing) secrets.delete(NAME);

        expect(decisions(await plan(after))).toEqual({
          "secrets-store": "noop",
          "token:deploy": "drift-recreate",
          "secret:deploy": secretMissing ? "drift-recreate" : "noop",
          "binding:api": "noop",
        });

        await deploy("second", after);

        expect([...tokens.keys()]).toEqual(["t2"]);
        expect(secrets.get(NAME)?.value).toBe("token-value-2");
        expect(operations).not.toContain("update binding api");
        expect(decisions(await plan(after))).toEqual({
          "secrets-store": "noop",
          "token:deploy": "noop",
          "secret:deploy": "noop",
          "binding:api": "noop",
        });
      });
    },
  );
});
