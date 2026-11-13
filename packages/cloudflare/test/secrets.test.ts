import {
  afterEach,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  it,
  vi,
} from "vitest";
import type * as cf from "@cloudflare/workers-types";
import {
  Redacted,
  runWithSecretContext,
  secretContext,
  setConfigFile,
  type Source,
} from "@notation/core";
import {
  collectResourceGraph,
  declaredIn,
  type ResourceGraph,
} from "@notation/resource";
import { secret, SecretGroup, SecretsStoreGroup } from "src/secrets-store";
import { accountToken, AccountTokenGroup } from "src/tokens";
import {
  $worker,
  isWorkerGroup,
  secretsStore,
  type WorkerEnv,
  type WorkerGroup,
} from "src/workers";
import * as runtime from "src/workers/runtime";

const compatibilityDate = "2026-10-12";

beforeEach(() => setConfigFile("/some/project/notation.config.ts"));
afterEach(() => {
  setConfigFile(undefined);
  vi.unstubAllEnvs();
});

const collect = (evaluate: () => unknown) =>
  collectResourceGraph(evaluate, { scope: { app: "shop", stage: "dev" } });

const inWorker = <T>(declaration: T, file: string): T =>
  declaredIn(declaration, file, "worker", { exports: [], starExports: [] });

const groupOf = <T>(graph: ResourceGraph, type: string, id: string): T => {
  const found = graph.resourceGroups.find(
    (g) => g.type === type && g.id === id,
  );
  if (!found) throw new Error(`No ${type} group ${id} in the graph`);
  return found as T;
};

const worker = (graph: ResourceGraph, id: string): WorkerGroup =>
  graph.resourceGroups.find(
    (g) => isWorkerGroup(g) && g.id === id,
  ) as WorkerGroup;

const vault: Source = {
  name: "vault",
  has: async () => true,
  get: async () => new Redacted("x"),
};

const policies = [
  {
    effect: "allow" as const,
    permissionGroups: ["Workers Scripts Write"],
    resources: { "com.cloudflare.api.account.acc": "*" },
  },
];

describe("secret", () => {
  it("references a secret named <app>--<stage>--<id> in the account's store", async () => {
    const graph = await collect(() => {
      secret({ id: "stripe-key" });
    });
    const group = groupOf<SecretGroup>(
      graph,
      "cloudflare/secret",
      "stripe-key",
    );
    const store = groupOf<SecretsStoreGroup>(
      graph,
      "cloudflare/secretsStore",
      "default",
    );

    expect(group.secret.id).toBe("secret:stripe-key");
    expect(group.secret.config).toEqual({
      Name: "shop--dev--stripe-key",
      StageScoped: true,
      ValueFrom: { Secret: "stripe-key", Source: "prompt" },
    });
    expect(group.value).toBeUndefined();
    expect(group.secret.dependencies.store).toBe(store.store);
    expect(store.store.id).toBe("secrets-store");
  });

  it("uses an explicit name as it is, and marks it as not stage-scoped", async () => {
    const graph = await collect(() => {
      secret({ id: "sentry", name: "SENTRY_DSN" });
    });
    const group = groupOf<SecretGroup>(graph, "cloudflare/secret", "sentry");

    expect(group.secret.config).toMatchObject({
      Name: "SENTRY_DSN",
      StageScoped: false,
    });
  });

  it("adds one store for all secrets and tokens", async () => {
    const graph = await collect(() => {
      secret({ id: "a" });
      secret({ id: "b" });
      accountToken({ id: "deploy", policies });
    });
    const stores = graph.resources.filter(
      (r) => r.type === "cloudflare/secrets-store/SecretsStore",
    );

    expect(stores).toHaveLength(1);
    const token = groupOf<AccountTokenGroup>(
      graph,
      "cloudflare/accountToken",
      "deploy",
    );
    expect(token.token.dependencies.store).toBe(stores[0]);
  });

  it("derives the account and store from the store's output", async () => {
    const graph = await collect(() => {
      secret({ id: "stripe-key" });
    });
    const group = groupOf<SecretGroup>(
      graph,
      "cloudflare/secret",
      "stripe-key",
    );
    group.secret.dependencies.store.setOutput({
      AccountId: "acc",
      StoreId: "store",
    });

    expect(await group.secret.getParams()).toEqual({
      AccountId: "acc",
      StoreId: "store",
      Name: "shop--dev--stripe-key",
      StageScoped: true,
      ValueFrom: { Secret: "stripe-key", Source: "prompt" },
    });
  });

  it("records its source and key in a SourceValue, and takes the version from it", async () => {
    const graph = await collect(() => {
      secret({ id: "stripe-key", source: vault, key: "STRIPE_KEY" });
    });
    const group = groupOf<SecretGroup>(
      graph,
      "cloudflare/secret",
      "stripe-key",
    );

    expect(group.value!.id).toBe("value:stripe-key");
    expect(group.value!.config).toEqual({ Source: "vault", Key: "STRIPE_KEY" });
    expect(group.secret.getDependencies()).toContain(group.value);

    group.secret.dependencies.store.setOutput({
      AccountId: "acc",
      StoreId: "store",
    });
    group.value!.setOutput({
      Source: "vault",
      Key: "STRIPE_KEY",
      Version: "14",
    });
    expect((await group.secret.getParams()).ValueFrom).toEqual({
      Secret: "stripe-key",
      Source: "vault",
      Key: "STRIPE_KEY",
      Version: "14",
    });
  });

  it("fails for a source without a key, or a key without a source", () => {
    expect(() => secret({ id: "stripe-key", source: vault } as any)).toThrow(
      `secret({ id: "stripe-key" }) has a source but no key. Give source and key together, or leave both out.`,
    );
    expect(() =>
      secret({ id: "stripe-key", key: "STRIPE_KEY" } as any),
    ).toThrow("has a key but no source");
  });

  it("declares secrets and tokens by id, and refuses to set a token's secret", async () => {
    const declared = await runWithSecretContext(
      { stage: "dev", runId: "run" },
      async () => {
        await collect(() => {
          secret({ id: "stripe-key", source: vault, key: "STRIPE_KEY" });
          secret({ id: "sentry", name: "SENTRY_DSN" });
          accountToken({ id: "deploy", policies });
        });
        return secretContext()!.declared;
      },
    );

    expect([...declared.keys()]).toEqual(["stripe-key", "sentry", "deploy"]);
    expect(declared.get("stripe-key")).toMatchObject({
      source: vault,
      key: "STRIPE_KEY",
    });
    expect(declared.get("stripe-key")!.resource.id).toBe("secret:stripe-key");
    expect(declared.get("sentry")!.refuseDelete).toContain(
      "has the explicit name SENTRY_DSN",
    );
    expect(declared.get("deploy")!.refuseSet).toContain(
      "is the secret of an API token",
    );
  });

  it("fails for a name with a dot", async () => {
    await expect(
      collect(() => {
        secret({ id: "key", name: "api.key" });
      }),
    ).rejects.toThrow(
      `secret({ id: "key", name: "api.key" }) has the secret name "api.key", but Cloudflare rejects a secret name with a dot.`,
    );
  });

  it("fails for a name longer than 255 characters", async () => {
    await expect(
      collect(() => {
        secret({ id: "key", name: "a".repeat(256) });
      }),
    ).rejects.toThrow("longer than Cloudflare's limit of 255 characters");
  });

  it("fails without an id", () => {
    expect(() => secret({} as any)).toThrow("secret() requires an id.");
  });

  it("fails when two secrets get the same name", async () => {
    await expect(
      collect(() => {
        secret({ id: "a", name: "SHARED" });
        secret({ id: "b", name: "SHARED" });
      }),
    ).rejects.toThrow(
      `secret({ id: "a", name: "SHARED" }) and secret({ id: "b", name: "SHARED" }) give two secrets the same name, "SHARED".`,
    );
  });

  it("fails when a secret and a token get the same name", async () => {
    await expect(
      collect(() => {
        secret({ id: "deploy" });
        accountToken({ id: "deploy", policies });
      }),
    ).rejects.toThrow(`give two secrets the same name, "shop--dev--deploy"`);
  });
});

describe("accountToken", () => {
  it("declares a token named <app>--<stage>--<id>, with its policies sorted", async () => {
    const graph = await collect(() => {
      accountToken({
        id: "deploy",
        policies: [
          {
            effect: "allow",
            permissionGroups: [
              "Workers Scripts Write",
              "Account Settings Read",
            ],
            resources: { "com.cloudflare.api.account.acc": "*" },
          },
        ],
      });
    });
    const group = groupOf<AccountTokenGroup>(
      graph,
      "cloudflare/accountToken",
      "deploy",
    );

    expect(group.token.id).toBe("token:deploy");
    expect(group.token.config).toEqual({
      Name: "shop--dev--deploy",
      Policies: [
        {
          effect: "allow",
          permissionGroups: ["Account Settings Read", "Workers Scripts Write"],
          resources: { "com.cloudflare.api.account.acc": "*" },
        },
      ],
    });
  });
});

describe("secretsStore.bind", () => {
  it("binds a secret and a token, and uploads the Worker after them", async () => {
    const graph = await collect(() => {
      const stripeKey = secret({ id: "stripe-key" });
      const deployToken = accountToken({ id: "deploy", policies });
      inWorker(
        $worker({
          id: "api",
          compatibilityDate,
          bindings: () => ({
            STRIPE_KEY: secretsStore.bind(stripeKey),
            DEPLOY_TOKEN: secretsStore.bind(deployToken),
            GREETING: "hello",
          }),
        }),
        "runtime/api.ts",
      );
    });
    const api = worker(graph, "api");
    const stripeKey = groupOf<SecretGroup>(
      graph,
      "cloudflare/secret",
      "stripe-key",
    ).secret;
    const deployToken = groupOf<AccountTokenGroup>(
      graph,
      "cloudflare/accountToken",
      "deploy",
    ).token;

    expect(api.script.getDependencies()).toEqual(
      expect.arrayContaining([stripeKey, deployToken]),
    );

    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "acc");
    api.code.setOutput({
      filePath: "dist/index.mjs",
      sourceSha256: "hex",
      fileSha256: "sha",
    });
    stripeKey.setOutput({
      AccountId: "acc",
      StoreId: "store",
      Name: "shop--dev--stripe-key",
      StageScoped: true,
      ValueFrom: { Secret: "stripe-key", Source: "prompt" },
      SecretId: "s1",
    });
    deployToken.setOutput({
      AccountId: "acc",
      StoreId: "store",
      Name: "shop--dev--deploy",
      Policies: policies,
      TokenId: "t1",
      SecretId: "s2",
    });

    expect((await api.script.getParams()).Bindings).toEqual([
      {
        type: "secrets_store_secret",
        name: "STRIPE_KEY",
        store_id: "store",
        secret_name: "shop--dev--stripe-key",
      },
      {
        type: "secrets_store_secret",
        name: "DEPLOY_TOKEN",
        store_id: "store",
        secret_name: "shop--dev--deploy",
      },
      { type: "plain_text", name: "GREETING", text: "hello" },
    ]);
  });

  it("fails for a secret bound without secretsStore.bind", async () => {
    await expect(
      collect(() => {
        const stripeKey = secret({ id: "stripe-key" });
        inWorker(
          $worker({
            id: "api",
            compatibilityDate,
            bindings: () => ({ STRIPE_KEY: stripeKey as any }),
          }),
          "runtime/api.ts",
        );
      }),
    ).rejects.toThrow(
      "binds STRIPE_KEY to a secret directly. Bind it with `STRIPE_KEY: secretsStore.bind(secret)`.",
    );
  });

  it("types the binding as a SecretsStoreSecret", () => {
    const stripeKey = {} as SecretGroup;
    const api = runtime.$worker({
      id: "api",
      compatibilityDate,
      bindings: () => ({ STRIPE_KEY: runtime.secretsStore.bind(stripeKey) }),
    });

    expectTypeOf<
      WorkerEnv<typeof api>["STRIPE_KEY"]
    >().toEqualTypeOf<cf.SecretsStoreSecret>();
  });
});
