import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
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
  clearSecretTargets,
  getSecretTarget,
  Redacted,
  runWithExecutionContext,
  setConfigFile,
} from "@notation/core";
import {
  createPlan,
  createResourceOperation,
  createStepRunner,
  deleteResourceOperation,
  runOperation,
  toEmitStep,
  updateResourceOperation,
} from "@notation/reconciler";
import {
  collectResourceGraph,
  declaredIn,
  type BaseResource,
  type ResourceGraph,
} from "@notation/resource";
import type { Source } from "@notation/std/sources";
import {
  $worker,
  accountToken,
  secret,
  secretsStore,
  type WorkerEnv,
  type WorkerGroup,
} from "src/index";
import * as rootInfra from "src/index";
import * as rootRuntime from "src/runtime";
import { isWorkerGroup } from "src/workers";

const compatibilityDate = "2026-10-12";

let projectDir: string;

beforeEach(() => {
  clearSecretTargets();
  projectDir = mkdtempSync(path.join(os.tmpdir(), "notation-cf-secrets-"));
  writeFileSync(
    path.join(projectDir, "notation.config.ts"),
    "export default {}",
  );
  setConfigFile(path.join(projectDir, "notation.config.ts"));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  clearSecretTargets();
  setConfigFile(undefined);
  rmSync(projectDir, { recursive: true, force: true });
});

const collect = (evaluate: () => unknown) =>
  collectResourceGraph(evaluate, { scope: { app: "shop", stage: "dev" } });

const inWorker = <T>(declaration: T, file: string): T =>
  declaredIn(declaration, file, "worker", { exports: [], starExports: [] });

function findWorkerGroup(graph: ResourceGraph, id: string): WorkerGroup {
  const found = graph.resourceGroups.find(
    (g) => isWorkerGroup(g) && g.id === id,
  );
  if (!found) throw new Error(`No Worker group ${id} in graph`);
  return found as WorkerGroup;
}

describe("secret() declaration", () => {
  it("declares a prompt secret sharing a singleton SecretsStore and registers its secret target", async () => {
    const graph = await collect(() => {
      const a = secret({ id: "stripe-key" });
      const b = secret({ id: "jwt-secret", name: "SHARED_JWT" });
      return { a, b };
    });

    const ids = graph.resources.map((r) => r.id);
    expect(ids).toEqual([
      "secrets-store",
      "secret:stripe-key",
      "secret:jwt-secret",
    ]);

    const targetA = getSecretTarget("stripe-key");
    expect(targetA?.source).toBeUndefined();
    expect(targetA?.key).toBeUndefined();
    expect(targetA?.isToken).toBeFalsy();
    expect(targetA?.resource.id).toBe("secret:stripe-key");

    const secretA = graph.resources.find((r) => r.id === "secret:stripe-key")!;
    const secretB = graph.resources.find((r) => r.id === "secret:jwt-secret")!;
    expect((secretA as any).config.Name).toBe("shop--dev--stripe-key");
    expect((secretA as any).config.Adopted).toBeUndefined();
    expect((secretB as any).config.Name).toBe("SHARED_JWT");
    expect((secretB as any).config.Adopted).toBe(true);
    expect(secretA.dependencies.store).toBe(secretB.dependencies.store);
  });

  it("declares SourceValue + SecretsStoreSecret when source and key are provided", async () => {
    const vault: Source = {
      name: "vault",
      has: async () => true,
      get: async () => new Redacted("val"),
      version: async () => "v1",
    };

    let boundRef: ReturnType<typeof secret> | undefined;
    const graph = await collect(() => {
      boundRef = secret({ id: "stripe-key", source: vault, key: "STRIPE_KEY" });
    });

    expect(graph.resources.map((r) => r.id)).toEqual([
      "secrets-store",
      "value:stripe-key",
      "secret:stripe-key",
    ]);
    const sec = graph.resources.find((r) => r.id === "secret:stripe-key")!;
    const val = graph.resources.find((r) => r.id === "value:stripe-key")!;
    expect(sec.dependencies.value).toBe(val);

    const target = getSecretTarget("stripe-key");
    expect(target?.source).toBe(vault);
    expect(target?.key).toBe("STRIPE_KEY");

    const ref = boundRef!["~secret"]();
    expect(ref).toBe(sec);
    expect((ref as any).config.Name).toBe("shop--dev--stripe-key");
  });

  it("validates source/key pairing, name characters/length, and uniqueness", async () => {
    const vault: Source = {
      name: "vault",
      has: async () => true,
      get: async () => new Redacted("val"),
    };

    // Type-level pairing check
    if (false as boolean) {
      // @ts-expect-error source requires key
      secret({ id: "bad1", source: vault });
      // @ts-expect-error key requires source
      secret({ id: "bad2", key: "ONLY_KEY" });
    }

    await expect(
      collect(() => secret({ id: "bad1", source: vault } as any)),
    ).rejects.toThrow(/requires both source and key/);

    await expect(
      collect(() => secret({ id: "bad2", key: "ONLY_KEY" } as any)),
    ).rejects.toThrow(/requires both source and key/);

    await expect(collect(() => secret({ id: "has.dot" }))).rejects.toThrow(
      /rejects names containing "\."/,
    );

    await expect(
      collect(() => secret({ id: "explicit-dot", name: "my.secret" })),
    ).rejects.toThrow(/rejects names containing "\."/);

    await expect(
      collect(() => secret({ id: "too-long", name: "a".repeat(256) })),
    ).rejects.toThrow(/at most 255 characters/);

    await expect(
      collect(() => {
        secret({ id: "dup" });
        secret({ id: "dup" });
      }),
    ).rejects.toThrow(/Duplicate secret id "dup"/);

    await expect(
      collect(() => {
        secret({ id: "a", name: "SAME_NAME" });
        secret({ id: "b", name: "SAME_NAME" });
      }),
    ).rejects.toThrow(/the same name, "SAME_NAME"/);
  });
});

describe("accountToken() declaration", () => {
  it("declares AccountToken on the singleton SecretsStore and marks secret target as isToken", async () => {
    const graph = await collect(() => {
      const sec = secret({ id: "stripe-key" });
      const tok = accountToken({
        id: "deploy-bot",
        policies: [
          {
            effect: "allow",
            permissionGroups: ["Workers Scripts Write"],
            resources: { "com.cloudflare.api.account.*": "*" },
          },
        ],
      });
      return { sec, tok };
    });

    expect(graph.resources.map((r) => r.id)).toEqual([
      "secrets-store",
      "secret:stripe-key",
      "token:deploy-bot",
    ]);

    const tokTarget = getSecretTarget("deploy-bot");
    expect(tokTarget?.isToken).toBe(true);
    expect(tokTarget?.resource.id).toBe("token:deploy-bot");

    const secRes = graph.resources.find((r) => r.id === "secret:stripe-key")!;
    const tokRes = graph.resources.find((r) => r.id === "token:deploy-bot")!;
    expect(tokRes.dependencies.store).toBe(secRes.dependencies.store);
  });

  it("validates policies, dots, 120-char name limit, and id collisions with secret()", async () => {
    await expect(
      collect(() =>
        accountToken({
          id: "empty-pol",
          policies: [],
        }),
      ),
    ).rejects.toThrow(/at least one policy/);

    await expect(
      collect(() =>
        accountToken({
          id: "bad.tok",
          policies: [
            {
              effect: "allow",
              permissionGroups: [{ id: "pg-1" }],
              resources: { "com.cloudflare.api.account.*": "*" },
            },
          ],
        }),
      ),
    ).rejects.toThrow(/rejects names containing "\."/);

    // "shop--dev--" is 11 chars, so id of 110 chars hits 121 chars > 120
    await expect(
      collect(() =>
        accountToken({
          id: "x".repeat(110),
          policies: [
            {
              effect: "allow",
              permissionGroups: [{ id: "pg-1" }],
              resources: { "com.cloudflare.api.account.*": "*" },
            },
          ],
        }),
      ),
    ).rejects.toThrow(/at most 120 characters/);

    await expect(
      collect(() => {
        secret({ id: "shared" });
        accountToken({
          id: "shared",
          policies: [
            {
              effect: "allow",
              permissionGroups: [{ id: "pg-1" }],
              resources: { "com.cloudflare.api.account.*": "*" },
            },
          ],
        });
      }),
    ).rejects.toThrow(/Duplicate secret id "shared"/);
  });
});

describe("secretsStore.bind and WorkerEnv", () => {
  it("emits secrets_store_secret bindings and dependencies on WorkerScript and types env as cf.SecretsStoreSecret", async () => {
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "acc-1");

    const graph = await collect(() => {
      const stripeKey = secret({ id: "stripe-key" });
      const deployToken = accountToken({
        id: "deploy-token",
        policies: [
          {
            effect: "allow",
            permissionGroups: [{ id: "pg-workers" }],
            resources: { "com.cloudflare.api.account.acc-1": "*" },
          },
        ],
      });
      const worker = inWorker(
        $worker({
          id: "api",
          compatibilityDate,
          bindings: () => ({
            STRIPE_KEY: secretsStore.bind(stripeKey),
            CF_TOKEN: secretsStore.bind(deployToken),
          }),
        }),
        "runtime/api.ts",
      );

      type Env = WorkerEnv<typeof worker>;
      expectTypeOf<Env["STRIPE_KEY"]>().toEqualTypeOf<cf.SecretsStoreSecret>();
      expectTypeOf<Env["CF_TOKEN"]>().toEqualTypeOf<cf.SecretsStoreSecret>();
    });

    const api = findWorkerGroup(graph, "api");
    const store = graph.resources.find((r) => r.id === "secrets-store")!;
    const sec = graph.resources.find((r) => r.id === "secret:stripe-key")!;
    const tok = graph.resources.find((r) => r.id === "token:deploy-token")!;

    expect(api.script.getDependencies()).toContain(sec);
    expect(api.script.getDependencies()).toContain(tok);

    // Simulate store, secret, token, and bundle outputs being deployed
    api.code.setOutput({
      filePath: "dist/index.mjs",
      sourceSha256: "hex",
      fileSha256: "sha",
    });
    store.setOutput({ AccountId: "acc-1", StoreId: "store-1" } as any);
    sec.setOutput({
      AccountId: "acc-1",
      StoreId: "store-1",
      Name: "shop--dev--stripe-key",
      ValueFrom: { Source: "prompt" },
      SecretId: "sec-1",
    } as any);
    tok.setOutput({
      AccountId: "acc-1",
      StoreId: "store-1",
      Name: "shop--dev--deploy-token",
      TokenId: "tok-1",
      SecretId: "sec-2",
      Policies: [],
    } as any);

    const params = await api.script.getParams();
    expect(params.Bindings).toEqual([
      {
        type: "secrets_store_secret",
        name: "STRIPE_KEY",
        store_id: "store-1",
        secret_name: "shop--dev--stripe-key",
      },
      {
        type: "secrets_store_secret",
        name: "CF_TOKEN",
        store_id: "store-1",
        secret_name: "shop--dev--deploy-token",
      },
    ]);
  });

  it("rejects raw secret() without secretsStore.bind() or invalid inputs to bind() at compile time", () => {
    if (false as boolean) {
      const s = rootRuntime.secret({ id: "s" });
      rootRuntime.$worker({
        id: "api",
        compatibilityDate,
        // @ts-expect-error raw secret() must be wrapped with secretsStore.bind()
        bindings: () => ({ S: s }),
      });
      // @ts-expect-error secretsStore.bind requires a BindableSecret
      rootRuntime.secretsStore.bind("not-a-secret");
    }
  });
});

describe("root export parity and runtime stubs", () => {
  it("keeps runtime export keys identical to infra root exports and throws in Worker runtime", () => {
    expect(Object.keys(rootRuntime).sort()).toEqual(
      Object.keys(rootInfra).sort(),
    );

    expect(() => rootRuntime.secret({ id: "s" })).toThrow(
      /declares infrastructure/,
    );
    expect(() =>
      rootRuntime.accountToken({
        id: "t",
        policies: [
          {
            effect: "allow",
            permissionGroups: ["Workers Scripts Write"],
            resources: { "com.cloudflare.api.account.*": "*" },
          },
        ],
      }),
    ).toThrow(/declares infrastructure/);
    expect(() => rootRuntime.secretsStore.bind({} as any)).toThrow(
      /declares infrastructure/,
    );
  });
});

describe("end-to-end plan and reconciler lifecycle", () => {
  function createMemoryState() {
    const records = new Map<string, any>();
    return {
      records,
      backend: {
        async get(id: string) {
          return records.get(id);
        },
        async values() {
          return [...records.values()];
        },
      },
    };
  }

  async function applyAll(
    resources: BaseResource[],
    records: Map<string, any>,
    backend: { get(id: string): Promise<any>; values(): Promise<any[]> },
  ) {
    const plan = await createPlan({ resources, state: backend });
    const step = createStepRunner();
    const byId = new Map(resources.map((r) => [r.id, r]));

    for (const node of plan.nodes) {
      const res = byId.get(node.id);
      const persist = async function* (record: any) {
        records.set(node.id, record);
      };
      const remove = async function* () {
        records.delete(node.id);
      };

      if (node.decision === "create" && res) {
        const resolvedParams = await res.getParams();
        await runOperation(
          createResourceOperation(step, {
            executionId: "exec-test",
            resource: res,
            resourceParams: resolvedParams,
            dependsOn: node.dependsOn,
            emit: toEmitStep(undefined),
            persist,
          }),
        );
      } else if (node.decision === "update" && res) {
        res.setOutput(records.get(node.id)!.output);
        const resolvedParams = await res.getParams();
        await runOperation(
          updateResourceOperation(step, {
            resource: res,
            resourceParams: resolvedParams,
            persistedOutput: records.get(node.id)!.output,
            patch: Object.fromEntries(
              Object.entries(node.diff ?? {}).map(([k, v]) => [k, v.after]),
            ),
            dependsOn: node.dependsOn,
            emit: toEmitStep(undefined),
            persist,
          }),
        );
      } else if (node.decision === "noop" && res) {
        res.setOutput(records.get(node.id)!.output);
      } else if (node.decision === "delete-orphan" && res) {
        await runOperation(
          deleteResourceOperation(step, {
            resource: res,
            emit: toEmitStep(undefined),
            remove,
          }),
        );
      }
    }
    return plan;
  }

  it("deploys, updates on source version change, and destroys without leaking secret or token values into state/plan/outputs", async () => {
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "acc-1");
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "cf-token");

    const SECRET_SENTINEL = "SENTINEL_SECRET_DO_NOT_LEAK";
    const TOKEN_SENTINEL = "SENTINEL_TOKEN_DO_NOT_LEAK";

    let remoteVersion = "v1";
    let currentSecret = `${SECRET_SENTINEL}_V1`;
    const vault: Source = {
      name: "vault",
      has: async (k) => k === "STRIPE_KEY",
      version: async () => remoteVersion,
      get: async () => new Redacted(currentSecret),
    };

    const cfSecrets = new Map<
      string,
      { id: string; name: string; value: string }
    >();
    const cfTokens = new Map<string, { id: string; name: string }>();
    let seq = 0;

    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const method = init?.method ?? "GET";
      const pathname = new URL(String(url)).pathname;
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      const ok = (result: unknown) =>
        Response.json({ success: true, errors: [], result });

      if (pathname === "/client/v4/accounts/acc-1/secrets_store/stores") {
        if (method === "GET") return ok([]);
        if (method === "POST") return ok({ id: "store-1", name: body.name });
      }
      if (
        pathname === "/client/v4/accounts/acc-1/secrets_store/stores/store-1"
      ) {
        if (method === "GET")
          return ok({ id: "store-1", name: "default_secrets_store" });
      }
      if (
        pathname ===
        "/client/v4/accounts/acc-1/secrets_store/stores/store-1/secrets"
      ) {
        if (method === "GET") {
          return ok(
            [...cfSecrets.values()].map(({ id, name }) => ({ id, name })),
          );
        }
        if (method === "POST") {
          const item = body[0];
          const id = `sec-${++seq}`;
          cfSecrets.set(id, { id, name: item.name, value: item.value });
          return ok([{ id, name: item.name }]);
        }
      }
      const secretMatch = pathname.match(
        /\/secrets_store\/stores\/store-1\/secrets\/([^/]+)$/,
      );
      if (secretMatch) {
        const id = secretMatch[1]!;
        if (method === "PATCH") {
          const existing = cfSecrets.get(id)!;
          existing.value = body.value;
          return ok({ id: existing.id, name: existing.name });
        }
        if (method === "DELETE") {
          cfSecrets.delete(id);
          return ok({ id });
        }
      }
      if (pathname === "/client/v4/accounts/acc-1/tokens") {
        if (method === "POST") {
          const id = `tok-${++seq}`;
          cfTokens.set(id, { id, name: body.name });
          return ok({
            id,
            name: body.name,
            value: TOKEN_SENTINEL,
            policies: body.policies,
          });
        }
      }
      const tokenMatch = pathname.match(/\/accounts\/acc-1\/tokens\/([^/]+)$/);
      if (tokenMatch) {
        const id = tokenMatch[1]!;
        if (method === "GET") {
          const tok = cfTokens.get(id);
          if (!tok) {
            return Response.json(
              {
                success: false,
                errors: [{ code: 1000, message: "not found" }],
                result: null,
              },
              { status: 404 },
            );
          }
          return ok({
            id,
            name: tok.name,
            policies: [
              {
                effect: "allow",
                permission_groups: [{ id: "pg-workers" }],
                resources: { "com.cloudflare.api.account.acc-1": "*" },
              },
            ],
          });
        }
        if (method === "DELETE") {
          cfTokens.delete(id);
          return ok({ id });
        }
      }
      throw new Error(`Unhandled ${method} ${pathname}`);
    });

    // Write dummy worker bundle so only secret/store/token/value resources are tested via reconciler
    mkdirSync(path.join(projectDir, "dist/runtime/api"), { recursive: true });
    writeFileSync(
      path.join(projectDir, "dist/runtime/api/index.mjs"),
      "export default {}",
    );

    const buildGraph = async () => {
      clearSecretTargets();
      const graph = await collect(() => {
        const stripe = secret({
          id: "stripe-key",
          source: vault,
          key: "STRIPE_KEY",
        });
        const shared = secret({
          id: "shared-secret",
          name: "org--shared--key",
          source: vault,
          key: "STRIPE_KEY",
        });
        const tok = accountToken({
          id: "bot",
          policies: [
            {
              effect: "allow",
              permissionGroups: [{ id: "pg-workers" }],
              resources: { "com.cloudflare.api.account.acc-1": "*" },
            },
          ],
        });
        return { stripe, shared, tok };
      });
      return graph.resources;
    };

    const { records, backend } = createMemoryState();

    // 1. Initial deploy
    const res1 = await buildGraph();
    await runWithExecutionContext({ stage: "dev", executionId: "e1" }, () =>
      applyAll(res1, records, backend),
    );

    expect([...cfSecrets.values()].map((s) => [s.name, s.value])).toEqual([
      ["shop--dev--stripe-key", "SENTINEL_SECRET_DO_NOT_LEAK_V1"],
      ["org--shared--key", "SENTINEL_SECRET_DO_NOT_LEAK_V1"],
      ["shop--dev--bot", TOKEN_SENTINEL],
    ]);

    const serializedState1 = JSON.stringify([...records.entries()]);
    expect(serializedState1).not.toContain(SECRET_SENTINEL);
    expect(serializedState1).not.toContain(TOKEN_SENTINEL);
    expect(records.get("secret:stripe-key")!.output).toMatchObject({
      StoreId: "store-1",
      Name: "shop--dev--stripe-key",
      ValueFrom: { Source: "vault", Key: "STRIPE_KEY", Version: "v1" },
    });
    expect(records.get("token:bot")!.output).toMatchObject({
      StoreId: "store-1",
      Name: "shop--dev--bot",
      TokenId: expect.any(String),
      SecretId: expect.any(String),
    });

    // 2. Bump source version -> updates only secrets backed by SourceValue, not token or store
    remoteVersion = "v2";
    currentSecret = `${SECRET_SENTINEL}_V2`;
    const res2 = await buildGraph();
    const plan2 = await runWithExecutionContext(
      { stage: "dev", executionId: "e2" },
      () => applyAll(res2, records, backend),
    );
    expect(plan2.nodes.map((n) => [n.id, n.decision])).toEqual([
      ["secrets-store", "noop"],
      ["value:stripe-key", "noop"],
      ["value:shared-secret", "noop"],
      ["secret:stripe-key", "update"],
      ["secret:shared-secret", "update"],
      ["token:bot", "noop"],
    ]);
    expect(JSON.stringify(plan2)).not.toContain(SECRET_SENTINEL);
    expect(JSON.stringify(plan2)).not.toContain(TOKEN_SENTINEL);
    expect(JSON.stringify([...records.entries()])).not.toContain(
      SECRET_SENTINEL,
    );
    expect(JSON.stringify([...records.entries()])).not.toContain(
      TOKEN_SENTINEL,
    );

    expect(
      [...cfSecrets.values()].find((s) => s.name === "shop--dev--stripe-key")
        ?.value,
    ).toBe("SENTINEL_SECRET_DO_NOT_LEAK_V2");

    // 3. Delete secrets/tokens: stage-scoped secret and token+secret are removed, explicit secret remains in Cloudflare
    const step = createStepRunner();
    for (const r of [...res2].reverse()) {
      r.setOutput(records.get(r.id)!.output);
      await runOperation(
        deleteResourceOperation(step, {
          resource: r,
          emit: toEmitStep(undefined),
          remove: async function* () {
            records.delete(r.id);
          },
        }),
      );
    }

    expect(cfTokens.size).toBe(0);
    // Explicit shared secret (even containing `--`) was left untouched in Cloudflare, stage-scoped secret & token secret deleted
    expect([...cfSecrets.values()].map((s) => s.name)).toEqual([
      "org--shared--key",
    ]);
  });
});
