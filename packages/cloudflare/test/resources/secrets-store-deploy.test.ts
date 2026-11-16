import { randomUUID } from "node:crypto";
import { readdir, readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NodeDurableRuntime, runDurableWorkflow } from "@notation/core";
import {
  createPlan,
  createResourceRegistry,
  type ReconcilerEvent,
} from "@notation/reconciler";
import * as durable from "@notation/reconciler/durable";
import { collectResourceGraph } from "@notation/resource";
import * as cloudflare from "src/resources";
import { loads, sourceValues, TestSource } from "../fixtures/test-source";

const SENTINEL = "sentinel-7c1e5d0a-value";

let directory: string;
let runtime: NodeDurableRuntime;
let events: ReconcilerEvent[];
let secrets: Map<string, { id: string; value: string }>;
// The account's API tokens, by ID, each with its value.
let tokens: Map<string, string>;
let issued: number;
// Set to make Cloudflare echo the value back in an error, as an API can.
let rejectWrites: boolean;

const fail = (message: string) =>
  Response.json(
    { success: false, errors: [{ code: 1001, message }], result: null },
    { status: 400 },
  );
const ok = (result: unknown) =>
  Response.json({ success: true, errors: [], result });

const TOKEN_VALUE = "token-5d2a9c40-value";

// The API tokens of the account. Each create and each roll issues a new
// value, numbered from 1.
function fakeTokens(method: string, route: string): Response {
  const issue = (id: string) => {
    issued += 1;
    tokens.set(id, `${TOKEN_VALUE}-${issued}`);
    return tokens.get(id)!;
  };
  if (route === "/permission_groups") {
    return ok([{ id: "g1", name: "Workers Scripts Write" }]);
  }
  if (route === "" && method === "GET") return ok([]);
  if (route === "" && method === "POST") {
    const id = `t${tokens.size + 1}`;
    return ok({ id, value: issue(id) });
  }
  const [, id, action] = route.split("/");
  if (!tokens.has(id!)) return fail("Invalid API Token");
  if (action === "value" && method === "PUT") return ok(issue(id!));
  if (method === "DELETE") tokens.delete(id!);
  return ok({
    policies: [
      {
        effect: "allow",
        permission_groups: [{ id: "g1" }],
        resources: { "com.cloudflare.api.account.acc": "*" },
      },
    ],
  });
}

// The Secrets Store API of one account with one store, and its API tokens.
function fakeCloudflare() {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const tokensPath = "/client/v4/accounts/acc/tokens";
    if (url.pathname.startsWith(tokensPath)) {
      return fakeTokens(method, url.pathname.slice(tokensPath.length));
    }
    const route = url.pathname.replace(
      "/client/v4/accounts/acc/secrets_store/stores",
      "",
    );
    if (route === "" && method === "GET") return ok([{ id: "st", name: "s" }]);
    if (route === "/st" && method === "GET") return ok({ id: "st", name: "s" });
    if (route === "/st/secrets" && method === "GET") {
      return ok(
        [...secrets.entries()].map(([name, { id }]) => ({
          id,
          name,
          status: "active",
        })),
      );
    }
    if (route === "/st/secrets" && method === "POST") {
      const [{ name, value }] = body;
      if (rejectWrites) return fail(`invalid secret value ${value}`);
      secrets.set(name, { id: `id-${name}`, value });
      return ok([{ id: `id-${name}`, name, status: "active" }]);
    }
    const patch = route.match(/^\/st\/secrets\/id-(.+)$/);
    if (patch && method === "DELETE") {
      secrets.delete(patch[1]!);
      return ok(null);
    }
    if (patch && method === "PATCH") {
      if (rejectWrites) {
        return fail(`invalid secret value ${JSON.stringify(body.value)}`);
      }
      secrets.set(patch[1]!, { id: `id-${patch[1]}`, value: body.value });
      return ok({ id: `id-${patch[1]}` });
    }
    return fail(`unexpected ${method} ${url.pathname}`);
  });
}

const scope = { app: "shop", stage: "dev" };

const policies = [
  {
    effect: "allow" as const,
    permissionGroups: ["Workers Scripts Write"],
    resources: { "com.cloudflare.api.account.acc": "*" },
  },
];

const sourcedSecret = () => {
  const store = new cloudflare.secretsStore.SecretsStore("store");
  const stripeKey = new TestSource("stripe-key", {
    config: { key: "STRIPE_KEY" },
  });
  new cloudflare.secretsStore.SecretsStoreSecret("stripe-key-secret", {
    config: { Value: stripeKey.credentials.value },
    dependencies: { store },
  });
};

const tokenSecret = () => {
  const store = new cloudflare.secretsStore.SecretsStore("store");
  const token = new cloudflare.tokens.AccountToken("deploy-token", {
    config: { Policies: policies },
  });
  new cloudflare.secretsStore.SecretsStoreSecret("deploy-token-secret", {
    config: { Value: token.credentials.Value },
    dependencies: { store },
  });
};

let declared: () => void;

const collect = () => collectResourceGraph(declared, { scope });

const registry = createResourceRegistry([
  cloudflare.secretsStore.SecretsStore,
  cloudflare.secretsStore.SecretsStoreSecret,
  cloudflare.tokens.AccountToken,
]);

async function deploy(executionId: string) {
  const { resources } = await collect();
  await runDurableWorkflow(
    { workflowId: "deploy", runtime, executionId },
    (step, id) =>
      durable.deploy(step, {
        executionId: id,
        resources,
        registry,
        state: runtime.state,
        nameScope: scope,
        emit: (event) => {
          events.push(event);
        },
      }),
  );
}

async function destroy(executionId: string) {
  const { resources } = await collect();
  await runDurableWorkflow(
    { workflowId: "destroy", runtime, executionId },
    (step, id) =>
      durable.destroy(step, {
        executionId: id,
        resources,
        registry,
        state: runtime.state,
        emit: (event) => {
          events.push(event);
        },
      }),
  );
}

async function plan() {
  const { resources } = await collect();
  return createPlan({
    resources,
    state: runtime.state,
    registry,
    nameScope: scope,
  });
}

async function decisions() {
  const planned = await plan();
  return Object.fromEntries(
    planned.nodes.map((node) => [node.id, node.decision]),
  );
}

const onlySecret = () => {
  expect(secrets.size).toBe(1);
  return [...secrets.keys()][0]!;
};

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "notation-cf-secrets-"));
  runtime = new NodeDurableRuntime({
    deployment: { app: "shop", stage: "dev" },
    databasePath: path.join(directory, "workflows.db"),
  });
  events = [];
  secrets = new Map();
  tokens = new Map();
  issued = 0;
  declared = sourcedSecret;
  rejectWrites = false;
  sourceValues.clear();
  // Deploy holds a value for the life of the process, by its version. A
  // revision of its own keeps each test from finding the value of another.
  sourceValues.set("STRIPE_KEY", { value: SENTINEL, revision: randomUUID() });
  loads.length = 0;
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

describe("a secret that takes a source's value", () => {
  it("writes the value to a secret named <app>--<stage>--<id>-<instance>, and records a marker in its place", async () => {
    await deploy("first");

    const name = onlySecret();
    expect(name).toMatch(/^shop--dev--stripe-key-secret-[0-9a-f]{8}$/);
    expect(secrets.get(name)?.value).toBe(SENTINEL);
    expect((await runtime.state.get("stripe-key-secret"))?.params).toEqual({
      AccountId: "acc",
      StoreId: "st",
      Name: name,
      Value: {
        $credential: {
          resource: "stripe-key",
          name: "value",
          version: expect.any(String),
        },
      },
    });
    expect(await decisions()).toEqual({
      store: "noop",
      "stripe-key": "noop",
      "stripe-key-secret": "noop",
    });
  });

  it("writes the value again only when the source has a new revision, and keeps the name", async () => {
    await deploy("first");
    const name = onlySecret();
    secrets.get(name)!.value = "changed by hand";

    await deploy("second");
    expect(secrets.get(name)?.value).toBe("changed by hand");
    expect(loads).toEqual(["STRIPE_KEY"]);

    sourceValues.set("STRIPE_KEY", {
      value: "sk_rotated",
      revision: randomUUID(),
    });
    expect(await decisions()).toMatchObject({
      "stripe-key": "update",
      "stripe-key-secret": "update",
    });
    await deploy("third");

    expect(onlySecret()).toBe(name);
    expect(secrets.get(name)?.value).toBe("sk_rotated");
    expect(await decisions()).toMatchObject({ "stripe-key-secret": "noop" });
  });

  it("creates a secret deleted outside notation again, with the source's value", async () => {
    await deploy("first");
    secrets.delete(onlySecret());

    await deploy("second");

    expect(secrets.get(onlySecret())?.value).toBe(SENTINEL);
  });

  it("deletes the secret on destroy", async () => {
    await deploy("first");

    await destroy("destroy");

    expect(secrets.size).toBe(0);
  });
});

describe("a secret that takes an account token's value", () => {
  async function recorded(): Promise<string> {
    const files = await readdir(directory);
    const contents = await Promise.all(
      files.map((file) => readFile(path.join(directory, file))),
    );
    return [
      Buffer.concat(contents).toString("latin1"),
      JSON.stringify(await runtime.state.values()),
      JSON.stringify(events),
    ].join("\n");
  }

  beforeEach(() => {
    declared = tokenSecret;
  });

  it("names the token <app>--<stage>--<id>-<instance>, writes its value to the secret, and records a marker in its place", async () => {
    await deploy("first");

    expect(tokens.get("t1")).toBe(`${TOKEN_VALUE}-1`);
    const token = (await runtime.state.get("deploy-token"))!;
    expect(token.params.Name).toMatch(/^shop--dev--deploy-token-[0-9a-f]{8}$/);
    expect(secrets.get(onlySecret())?.value).toBe(`${TOKEN_VALUE}-1`);
    const marker = token.output.Value;
    expect(marker).toEqual({
      $credential: {
        resource: "deploy-token",
        name: "Value",
        version: expect.any(String),
      },
    });
    expect(
      (await runtime.state.get("deploy-token-secret"))!.params.Value,
    ).toEqual(marker);
    expect(await recorded()).not.toContain(TOKEN_VALUE);

    const planned = await plan();
    expect(planned.nodes.map((node) => node.decision)).toEqual([
      "noop",
      "noop",
      "noop",
    ]);
    expect(JSON.stringify(planned)).not.toContain(TOKEN_VALUE);
  });

  it("rolls the token in the deploy after one that failed to write its secret", async () => {
    rejectWrites = true;
    await expect(deploy("first")).rejects.toThrow("invalid secret value");
    expect(secrets.size).toBe(0);
    rejectWrites = false;

    await deploy("second");

    expect([...tokens]).toEqual([["t1", `${TOKEN_VALUE}-2`]]);
    expect(secrets.get(onlySecret())?.value).toBe(`${TOKEN_VALUE}-2`);
    expect(await recorded()).not.toContain(TOKEN_VALUE);
  });

  it("removes the value from an error that echoes it", async () => {
    rejectWrites = true;

    const error = await deploy("first").catch((e: Error) => e);

    expect((error as Error).message).toContain("invalid secret value <hidden>");
    expect(await recorded()).not.toContain(TOKEN_VALUE);
  });
});

// Rule 1 of RFC 0017: notation never records a secret's value.
describe("the sentinel", () => {
  async function recordedFiles(): Promise<Buffer> {
    const files = await readdir(directory);
    return Buffer.concat(
      await Promise.all(
        files.map((file) => readFile(path.join(directory, file))),
      ),
    );
  }

  it("is in no state record, journal, plan, event or error, even when Cloudflare echoes it", async () => {
    await deploy("first");
    sourceValues.set("STRIPE_KEY", { value: SENTINEL, revision: randomUUID() });
    const planned = await plan();
    rejectWrites = true;
    const error = await deploy("second").catch((e: Error) => e);

    // Cloudflare received the value, and echoed it in its error.
    expect(secrets.get(onlySecret())?.value).toBe(SENTINEL);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("invalid secret value");

    const forms = (value: string) => [
      value,
      Buffer.from(value).toString("base64"),
    ];
    const recorded = {
      state: JSON.stringify(await runtime.state.values()),
      plan: JSON.stringify(planned),
      events: JSON.stringify(events),
      error: `${(error as Error).message}\n${(error as Error).stack}`,
    };
    const files = await recordedFiles();
    for (const value of forms(SENTINEL)) {
      for (const [where, text] of Object.entries(recorded)) {
        expect(text, `${where} holds a secret value`).not.toContain(value);
      }
      expect(files.includes(value), "the journal holds a secret value").toBe(
        false,
      );
    }
    expect(recorded.error).toContain("<hidden>");
  });
});
