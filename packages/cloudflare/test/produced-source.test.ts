import { readdir, readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  NodeDurableRuntime,
  runDurableWorkflow,
  runWithSecretContext,
  secretContext,
  setConfigFile,
} from "@notation/core";
import {
  createPlan,
  createResourceRegistry,
  type ReconcilerEvent,
} from "@notation/reconciler";
import * as durable from "@notation/reconciler/durable";
import { collectResourceGraph, declaredIn } from "@notation/resource";
import { env } from "@notation/std/sources";
import { SecretsStore, SecretsStoreSecret } from "src/resources/secrets-store";
import { secret, type SecretGroup } from "src/secrets-store";
import { $worker, isWorkerGroup, secretsStore } from "src/workers";
import {
  FakeBinding,
  FakeKeyPair,
  fakeKeyPairGroup,
  fakeKeys,
  operations,
  producedValues,
} from "./fake-producer";

const NAME = "shop--dev--app-key";

let directory: string;
let runtime: NodeDurableRuntime;
let events: ReconcilerEvent[];
let secrets: Map<string, { id: string; value: string }>;
let rejectWrites: (name: string) => boolean;

const fail = (message: string) =>
  Response.json(
    { success: false, errors: [{ code: 1001, message }], result: null },
    { status: 400 },
  );
const ok = (result: unknown) =>
  Response.json({ success: true, errors: [], result });

// The Secrets Store API of one account with one store.
function fakeCloudflare() {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
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
      if (rejectWrites(name)) return fail(`invalid secret value ${value}`);
      secrets.set(name, { id: `id-${name}`, value });
      return ok([{ id: `id-${name}`, name, status: "active" }]);
    }
    const one = route.match(/^\/st\/secrets\/id-(.+)$/);
    if (one && method === "PATCH") {
      if (rejectWrites(one[1]!)) {
        return fail(`invalid secret value ${body.value}`);
      }
      secrets.set(one[1]!, { id: `id-${one[1]}`, value: body.value });
      return ok({ id: `id-${one[1]}` });
    }
    if (one && method === "DELETE") {
      secrets.delete(one[1]!);
      operations.push(`delete value ${one[1]}`);
      return ok(null);
    }
    return fail(`unexpected ${method} ${url.pathname}`);
  });
}

// A Worker-like resource that binds the secret, as `secretsStore.bind` does.
const bind = (group: SecretGroup, id = "api") =>
  new FakeBinding(`binding:${id}`, {
    config: {
      Id: id,
      StoreId: group.secret.outputRef("StoreId"),
      SecretName: group.secret.outputRef("Name"),
    },
  });

const infra =
  (producerId = "ci", options: { name?: string; bound?: boolean } = {}) =>
  () => {
    const app = fakeKeyPairGroup({ id: producerId, name: options.name });
    const appKey = secret({ id: "app-key", source: app.sources.privateKey });
    if (options.bound ?? true) bind(appKey);
  };

const collect = (evaluate: () => void) =>
  collectResourceGraph(evaluate, { scope: { app: "shop", stage: "dev" } });

// Stands in for `loadProviderRegistry`, which imports these classes for
// records whose type is no longer in code.
const loadedFromState = createResourceRegistry([
  FakeKeyPair,
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
        registry: loadedFromState,
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

const deploy = (executionId: string, evaluate: () => void = infra()) =>
  run("deploy", executionId, evaluate);

function plan(evaluate: () => void = infra()) {
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

// The resources whose creates succeeded, in order.
const created = () =>
  events.flatMap((event) =>
    event.event === "reconciler.operation.lifecycle" &&
    event.operation === "create" &&
    event.status === "success"
      ? [event.resourceId]
      : [],
  );

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "notation-cf-produced-"));
  runtime = new NodeDurableRuntime({
    deployment: { app: "shop", stage: "dev" },
    databasePath: path.join(directory, "workflows.db"),
  });
  events = [];
  secrets = new Map();
  rejectWrites = () => false;
  fakeKeys.clear();
  producedValues.length = 0;
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

async function recordedFiles(): Promise<Buffer> {
  const files = await readdir(directory);
  return Buffer.concat(
    await Promise.all(
      files.map((file) => readFile(path.join(directory, file))),
    ),
  );
}

describe("a secret whose source a resource produces", () => {
  it("plans the first deploy in the order store, producer, secret", async () => {
    const planned = await plan();

    expect(decisions(planned)).toEqual({
      "secrets-store": "create",
      "key-pair:ci": "create",
      "secret:app-key": "create",
      "binding:api": "create",
    });
    const node = (id: string) => planned.nodes.find((n) => n.id === id)!;
    const unknown = { $unknown: "after-apply" };
    expect(node("key-pair:ci").params).toEqual({
      Name: "ci",
      PrivateKeyTargets: [
        {
          provider: "@notation/cloudflare/resources",
          params: { AccountId: unknown, StoreId: unknown, Name: NAME },
        },
      ],
    });
    expect(node("secrets-store").dependsOn).toEqual([]);
    expect(node("key-pair:ci").dependsOn).toEqual(["secrets-store"]);
    expect([...node("secret:app-key").dependsOn].sort()).toEqual([
      "key-pair:ci",
      "secrets-store",
    ]);
    expect(node("binding:api").dependsOn).toEqual(["secret:app-key"]);
  });

  it("writes the produced value, and records only where it is", async () => {
    await deploy("first");

    expect(created()).toEqual([
      "secrets-store",
      "key-pair:ci",
      "secret:app-key",
      "binding:api",
    ]);
    expect(producedValues).toHaveLength(1);
    expect(secrets.get(NAME)?.value).toBe(producedValues[0]);
    expect((await runtime.state.get("key-pair:ci"))?.params).toEqual({
      Name: "ci",
      PrivateKeyTargets: [
        {
          provider: "@notation/cloudflare/resources",
          params: { AccountId: "acc", StoreId: "st", Name: NAME },
        },
      ],
    });
    expect((await runtime.state.get("secret:app-key"))?.params).toEqual({
      AccountId: "acc",
      StoreId: "st",
      Name: NAME,
      StageScoped: true,
      ValueFrom: {
        Secret: "app-key",
        Source: "produced",
        Producer: "key-pair:ci",
        Rotation: 'Rotate fakeKeyPair({ id: "ci" }) to write a new value.',
      },
    });

    const planned = await plan();
    expect(decisions(planned)).toEqual({
      "secrets-store": "noop",
      "key-pair:ci": "noop",
      "secret:app-key": "noop",
      "binding:api": "noop",
    });

    const recorded = {
      state: JSON.stringify(await runtime.state.values()),
      plan: JSON.stringify(planned),
      events: JSON.stringify(events),
    };
    for (const [where, text] of Object.entries(recorded)) {
      expect(text, `${where} holds the value`).not.toContain(producedValues[0]);
    }
    expect((await recordedFiles()).includes(producedValues[0]!)).toBe(false);
  });

  it("rolls back the producer and every write when one write fails", async () => {
    rejectWrites = (name) => name === "shop--dev--app-key-2";
    const twoSecrets = () => {
      const app = fakeKeyPairGroup({ id: "ci" });
      secret({ id: "app-key", source: app.sources.privateKey });
      secret({ id: "app-key-2", source: app.sources.privateKey });
    };

    const error = await deploy("first", twoSecrets).catch((e: Error) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("invalid secret value");
    expect((error as Error).message).toContain(
      "so a secret that held an earlier value may now be empty. The next plan shows each one as drift.",
    );
    expect((error as Error).message).not.toContain(producedValues[0]);
    expect(fakeKeys.size).toBe(0);
    expect(secrets.size).toBe(0);
    expect(await runtime.state.get("key-pair:ci")).toBeUndefined();
    expect(await runtime.state.get("secret:app-key")).toBeUndefined();
    expect(await runtime.state.get("secret:app-key-2")).toBeUndefined();

    rejectWrites = () => false;
    await deploy("second", twoSecrets);
    expect(fakeKeys.size).toBe(1);
    expect(secrets.get(NAME)?.value).toBe(producedValues[1]);
    expect(secrets.get(`${NAME}-2`)?.value).toBe(producedValues[1]);
  });

  it("keeps the new value when rotation changes the producer's id", async () => {
    await deploy("first");
    const secretRecord = await runtime.state.get("secret:app-key");
    operations.length = 0;

    await deploy("second", infra("ci-2"));

    expect(fakeKeys.size).toBe(1);
    expect(producedValues).toHaveLength(2);
    expect(secrets.get(NAME)?.value).toBe(producedValues[1]);
    // The new producer writes before the sweep deletes the old one, and
    // the binding is left as it was.
    expect(operations).toEqual(["create key pair ci-2", "delete key pair ci"]);
    const after = await runtime.state.get("secret:app-key");
    expect(after?.params.Name).toBe(secretRecord?.params.Name);
    expect(after?.params.ValueFrom).toEqual({
      Secret: "app-key",
      Source: "produced",
      Producer: "key-pair:ci-2",
      Rotation: 'Rotate fakeKeyPair({ id: "ci-2" }) to write a new value.',
    });
  });

  it("keeps the value when rotation replaces the producer under the same id", async () => {
    await deploy("first");
    operations.length = 0;

    await deploy("second", infra("ci", { name: "ci-rotated" }));

    expect(fakeKeys.size).toBe(1);
    expect(secrets.get(NAME)?.value).toBe(producedValues[1]);
    expect(operations).not.toContain(`delete value ${NAME}`);
    expect(operations).not.toContain("update binding api");
  });

  it("keeps the last value when the producer is removed and the secret stays", async () => {
    await deploy("first");
    const prompt = vi.fn(async () => "typed-in-value");
    operations.length = 0;

    await run(
      "deploy",
      "second",
      () => {
        bind(secret({ id: "app-key" }));
      },
      prompt,
    );

    // The secret now takes its value from the prompt. It exists, so update
    // keeps the value, and the sweep deletes only the key pair.
    expect(prompt).not.toHaveBeenCalled();
    expect(operations).toEqual(["delete key pair ci"]);
    expect(secrets.get(NAME)?.value).toBe(producedValues[0]);
    expect(
      (await runtime.state.get("secret:app-key"))?.params.ValueFrom,
    ).toEqual({ Secret: "app-key", Source: "prompt" });
  });

  it("detects a value deleted outside notation, and names the producer", async () => {
    await deploy("first");
    secrets.delete(NAME);

    expect(decisions(await plan())).toEqual({
      "secrets-store": "noop",
      "key-pair:ci": "noop",
      "secret:app-key": "drift-recreate",
      "binding:api": "noop",
    });
    await expect(deploy("second")).rejects.toThrow(
      'The secret shop--dev--app-key of `app-key` is missing. Only the create of its producer writes the value. Rotate fakeKeyPair({ id: "ci" }) to write a new value.',
    );

    // Rotating the producer writes the value again, and the secret
    // claims it.
    await deploy("third", infra("ci", { name: "ci-rotated" }));
    expect(secrets.get(NAME)?.value).toBe(producedValues[1]);
    expect(decisions(await plan(infra("ci", { name: "ci-rotated" })))).toEqual({
      "secrets-store": "noop",
      "key-pair:ci": "noop",
      "secret:app-key": "noop",
      "binding:api": "noop",
    });
  });

  it("fails the secret's create, naming the producer, when the value is missing", async () => {
    const create = new SecretsStoreSecret("secret:x", {
      config: {} as never,
      dependencies: { store: new SecretsStore("secrets-store") },
    }).create;

    await expect(
      create({
        AccountId: "acc",
        StoreId: "st",
        Name: NAME,
        StageScoped: true,
        ValueFrom: {
          Secret: "app-key",
          Source: "produced",
          Producer: "key-pair:ci",
          Rotation: 'Rotate fakeKeyPair({ id: "ci" }) to write a new value.',
        },
      }),
    ).rejects.toThrow(
      'The secret shop--dev--app-key of `app-key` is missing. Only the create of its producer writes the value. Rotate fakeKeyPair({ id: "ci" }) to write a new value.',
    );
  });

  it("orders a Worker that binds the secret after the producer", async () => {
    setConfigFile("/some/project/notation.config.ts");
    try {
      const graph = await collect(() => {
        const app = fakeKeyPairGroup({ id: "ci" });
        const appKey = secret({
          id: "app-key",
          source: app.sources.privateKey,
        });
        declaredIn(
          $worker({
            id: "api",
            compatibilityDate: "2026-10-12",
            bindings: () => ({ APP_KEY: secretsStore.bind(appKey) }),
          }),
          "runtime/api.ts",
          "worker",
          { exports: [], starExports: [] },
        );
      });
      const script = graph.resourceGroups.find(isWorkerGroup)!.script;
      const byId = (id: string) => graph.resources.find((r) => r.id === id)!;

      expect(script.getDependencies()).toContain(byId("secret:app-key"));
      expect(byId("secret:app-key").getDependencies()).toContain(
        byId("key-pair:ci"),
      );
    } finally {
      setConfigFile(undefined);
    }
  });

  it("writes the value to each secret that takes the source", async () => {
    await deploy("first", () => {
      const app = fakeKeyPairGroup({ id: "ci" });
      secret({ id: "app-key", source: app.sources.privateKey });
      secret({ id: "app-key-2", source: app.sources.privateKey });
    });

    expect(producedValues).toHaveLength(1);
    expect(secrets.get(NAME)?.value).toBe(producedValues[0]);
    expect(secrets.get(`${NAME}-2`)?.value).toBe(producedValues[0]);
  });

  it("replaces the producer when a secret starts to take its source", async () => {
    await deploy("first", infra("ci", { bound: false }));

    const twoSecrets = () => {
      const app = fakeKeyPairGroup({ id: "ci" });
      secret({ id: "app-key", source: app.sources.privateKey });
      secret({ id: "app-key-2", source: app.sources.privateKey });
    };
    expect(decisions(await plan(twoSecrets))).toMatchObject({
      "key-pair:ci": "replace",
      "secret:app-key": "noop",
      "secret:app-key-2": "create",
    });
    await deploy("second", twoSecrets);

    // Only a create gets a value, so the new target makes a new key pair,
    // whose value replaces the first secret's value too.
    expect(fakeKeys.size).toBe(1);
    expect(secrets.get(NAME)?.value).toBe(producedValues[1]);
    expect(secrets.get(`${NAME}-2`)?.value).toBe(producedValues[1]);
  });

  it("throws at collection when no secret takes the source", async () => {
    await expect(
      collect(() => {
        fakeKeyPairGroup({ id: "ci" });
      }),
    ).rejects.toThrow(
      'No secret takes fakeKeyPair({ id: "ci" }).sources.privateKey.',
    );
  });

  it("rejects a key with a produced source in the types", () => {
    // Only type-checked, never called.
    const declarations = () => {
      const app = fakeKeyPairGroup({ id: "ci" });
      // @ts-expect-error A produced source isn't asked for a key.
      secret({ id: "app-key", source: app.sources.privateKey, key: "X" });
      // @ts-expect-error A source that deploy reads needs a key.
      secret({ id: "other", source: env });
      secret({ id: "third", source: env, key: "THIRD" });
      secret({ id: "fourth", source: app.sources.privateKey });
    };
    expect(declarations).toBeTypeOf("function");
  });

  it("refuses notation secret set and delete, and names the producer", async () => {
    const declared = await runWithSecretContext(
      { stage: "dev", runId: "set" },
      async () => {
        await collect(infra());
        return secretContext()!.declared.get("app-key")!;
      },
    );

    expect(declared.set).toBeUndefined();
    expect(declared.delete).toBeUndefined();
    expect(declared.source).toBeUndefined();
    expect(declared.refusal).toBe(
      'Only the create of fakeKeyPair({ id: "ci" }) writes the value of `app-key`, so `notation secret` can\'t set or delete it. Rotate fakeKeyPair({ id: "ci" }) to write a new value.',
    );
  });

  it("destroys the binding, then the secret and its value, then the producer", async () => {
    await deploy("first");
    operations.length = 0;

    await run("destroy", "destroy", infra());

    expect(operations).toEqual([
      "delete binding api",
      `delete value ${NAME}`,
      "delete key pair ci",
    ]);
    expect(secrets.size).toBe(0);
    expect(fakeKeys.size).toBe(0);
    expect(await runtime.state.values()).toEqual([]);
  });
});
