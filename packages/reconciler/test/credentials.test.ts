import * as v from "valibot";
import {
  REDELIVERY_DELAY_BASE,
  WorkflowRunner,
  type HeapClient,
  type Runtime,
} from "@notation/durable/runtime";
import { SqliteRuntime, createSqliteDb } from "@notation/durable/sqlite/node";
import { createWorkflowRouter, workflow } from "@notation/durable";
import { resource, type BaseResource } from "@notation/resource";
import { clearSecretValues } from "@notation/utils";
import pino from "pino";
import { beforeEach, describe, expect, it } from "vitest";
import { clearHeldCredentials } from "../src/credentials";
import * as durable from "../src/durable";
import { createPlan } from "../src/planner";

type TokenSchema = {
  Key: { id: string };
  CreateParams: { scope: string };
  UpdateParams: {};
  ReadResult: {};
};

type SecretSchema = {
  Key: { name: string };
  CreateParams: { name: string; Value: string; label?: string };
  UpdateParams: { Value: string; label?: string };
  ReadResult: {};
};

/** What the fake provider holds, across deploys. */
type Provider = {
  tokens: Map<string, string>;
  secrets: Map<string, string>;
  calls: string[];
  failSecret?: string;
};

function createProvider(): Provider {
  return { tokens: new Map(), secrets: new Map(), calls: [] };
}

function defineResources(provider: Provider, { rotate }: { rotate: boolean }) {
  let issued = 0;
  const issue = (id: string) => {
    issued += 1;
    const value = `token-value-${issued}`;
    provider.tokens.set(id, value);
    return value;
  };

  const Token = resource<TokenSchema>({
    type: rotate ? "test/credentials/RotatableToken" : "test/credentials/Token",
    provider: "test",
  })
    .defineSchema({
      scope: {
        propertyType: "param",
        presence: "required",
        immutable: true,
        value: v.string(),
      },
      id: {
        propertyType: "computed",
        presence: "required",
        primaryKey: true,
        value: v.string(),
      },
      Value: { propertyType: "credential", value: v.string() },
    } as const)
    .defineOperations({
      create: async () => {
        const id = `token-${provider.tokens.size + provider.calls.length}`;
        provider.calls.push(`create ${id}`);
        return { id, Value: issue(id) };
      },
      ...(rotate
        ? {
            rotate: {
              Value: async (key) => {
                provider.calls.push(`rotate ${key.id}`);
                return issue(key.id);
              },
            },
          }
        : {}),
      delete: async (key) => {
        provider.calls.push(`delete ${key.id}`);
        provider.tokens.delete(key.id);
      },
    });

  const Secret = resource<SecretSchema>({
    type: "test/credentials/Secret",
    provider: "test",
  })
    .defineSchema({
      name: {
        propertyType: "param",
        presence: "required",
        immutable: true,
        primaryKey: true,
        value: v.string(),
      },
      Value: {
        propertyType: "param",
        presence: "required",
        sensitive: true,
        value: v.string(),
      },
      label: { propertyType: "param", presence: "optional", value: v.string() },
    } as const)
    .defineOperations({
      create: async (params) => {
        provider.calls.push(`create ${params.name}`);
        if (provider.failSecret === params.name) {
          throw new Error(`The store refused ${params.Value}`);
        }
        provider.secrets.set(params.name, params.Value);
      },
      update: async (key, patch) => {
        provider.calls.push(`update ${key.name}`);
        if (provider.failSecret === key.name) {
          throw new Error(`The store refused ${patch.Value}`);
        }
        if (patch.Value !== undefined) {
          provider.secrets.set(key.name, patch.Value);
        }
      },
      delete: async (key) => {
        provider.calls.push(`delete ${key.name}`);
        provider.secrets.delete(key.name);
      },
    });

  return { Token, Secret };
}

type Declared = {
  scope?: string;
  secrets: (string | { name: string; label: string })[];
};

/**
 * Declares one token, and a secret for each name that takes the token's
 * credential. Each deploy declares its resources again, as a new process
 * does.
 */
function declare(
  types: ReturnType<typeof defineResources>,
  { scope = "read", secrets }: Declared,
): BaseResource[] {
  const token = new types.Token("token", { config: { scope } });
  return [
    token,
    ...secrets.map((secret) => {
      const config = typeof secret === "string" ? { name: secret } : secret;
      return new types.Secret(`secret:${config.name}`, {
        config: { ...config, Value: token.credentials.Value },
      });
    }),
  ];
}

beforeEach(() => {
  clearHeldCredentials();
  clearSecretValues();
});

describe("a credential", () => {
  it("is passed to the resource that takes it, and is not written to state or the journal", async () => {
    const provider = createProvider();
    const types = defineResources(provider, { rotate: false });
    const runtime = createRuntime();

    await runtime.deploy("first", declare(types, { secrets: ["a"] }));

    expect(provider.secrets.get("a")).toBe("token-value-1");
    const token = await runtime.state.get("token");
    const version = (token!.output.Value as any).$credential.version;
    expect(version).toEqual(expect.any(String));
    expect(token!.output.Value).toEqual({
      $credential: { resource: "token", name: "Value", version },
    });
    expect((await runtime.state.get("secret:a"))!.params.Value).toEqual(
      token!.output.Value,
    );
    // The dump holds the journal and state: it has the marker.
    expect(runtime.dump()).toContain("$credential");
    expect(runtime.dump()).not.toContain("token-value-1");
    runtime.close();
  });

  it("is left alone by a deploy that changes nothing", async () => {
    const provider = createProvider();
    const types = defineResources(provider, { rotate: true });
    const runtime = createRuntime();
    await runtime.deploy("first", declare(types, { secrets: ["a"] }));
    provider.calls.length = 0;

    await runtime.nextProcess("second", declare(types, { secrets: ["a"] }));

    expect(provider.calls).toEqual([]);
    runtime.close();
  });

  it("updates the resources that take it when its resource is replaced", async () => {
    const provider = createProvider();
    const types = defineResources(provider, { rotate: false });
    const runtime = createRuntime();
    await runtime.deploy("first", declare(types, { secrets: ["a", "b"] }));

    await runtime.nextProcess(
      "second",
      declare(types, { scope: "write", secrets: ["a", "b"] }),
    );

    expect(provider.secrets.get("a")).toBe("token-value-2");
    expect(provider.secrets.get("b")).toBe("token-value-2");
    expect(runtime.dump()).not.toContain("token-value");
    runtime.close();
  });

  it("is removed from the error of the resource that takes it", async () => {
    const provider = createProvider();
    provider.failSecret = "a";
    const types = defineResources(provider, { rotate: false });
    const runtime = createRuntime();

    await expect(
      runtime.deploy("first", declare(types, { secrets: ["a"] })),
    ).rejects.toThrow("The store refused <hidden>");
    expect(runtime.dump()).not.toContain("token-value-1");
    runtime.close();
  });
});

describe("a resource that takes a credential in a later deploy", () => {
  it("gets a rotated value, and so does every resource that already takes it", async () => {
    const provider = createProvider();
    const types = defineResources(provider, { rotate: true });
    const runtime = createRuntime();
    await runtime.deploy("first", declare(types, { secrets: ["a"] }));
    provider.calls.length = 0;

    await runtime.nextProcess(
      "second",
      declare(types, { secrets: ["a", "b"] }),
    );

    expect(provider.calls).toEqual(["rotate token-0", "update a", "create b"]);
    expect(provider.secrets.get("a")).toBe("token-value-2");
    expect(provider.secrets.get("b")).toBe("token-value-2");
    expect(provider.tokens.get("token-0")).toBe("token-value-2");
    expect(runtime.dump()).not.toContain("token-value");
    runtime.close();
  });

  it("replaces the credential's resource when it has no rotate", async () => {
    const provider = createProvider();
    const types = defineResources(provider, { rotate: false });
    const runtime = createRuntime();
    await runtime.deploy("first", declare(types, { secrets: ["a"] }));
    provider.calls.length = 0;

    await runtime.nextProcess(
      "second",
      declare(types, { secrets: ["a", "b"] }),
    );

    expect(provider.calls).toEqual([
      "delete token-0",
      expect.stringMatching(/^create token-/),
      "update a",
      "create b",
    ]);
    expect(provider.secrets.get("a")).toBe("token-value-2");
    expect(provider.secrets.get("b")).toBe("token-value-2");
    runtime.close();
  });

  it("is planned as deploy does it", async () => {
    const provider = createProvider();
    const rotatable = defineResources(provider, { rotate: true });
    const fixed = defineResources(provider, { rotate: false });
    for (const [types, expected] of [
      [rotatable, { decision: "noop", rotates: ["Value"] }],
      [
        fixed,
        {
          decision: "replace",
          replaceFields: [{ name: "Value", known: true }],
        },
      ],
    ] as const) {
      const runtime = createRuntime();
      await runtime.deploy("first", declare(types, { secrets: ["a"] }));

      const plan = await createPlan({
        resources: declare(types, { secrets: ["a", "b"] }),
        state: runtime.state,
      });

      const [token, a, b] = plan.nodes;
      expect(token).toMatchObject(expected);
      expect(a).toMatchObject({ decision: "update" });
      expect(b).toMatchObject({ decision: "create" });
      runtime.close();
    }
  });
});

describe("a deploy that fails before a resource took the new value", () => {
  it("rotates again in the next deploy, and updates every resource", async () => {
    const provider = createProvider();
    const types = defineResources(provider, { rotate: true });
    const runtime = createRuntime();
    await runtime.deploy("first", declare(types, { secrets: ["a"] }));
    provider.failSecret = "b";
    await expect(
      runtime.nextProcess("second", declare(types, { secrets: ["a", "b"] })),
    ).rejects.toThrow("The store refused");
    provider.failSecret = undefined;
    provider.calls.length = 0;

    await runtime.nextProcess("third", declare(types, { secrets: ["a", "b"] }));

    expect(provider.calls).toEqual(["rotate token-0", "update a", "create b"]);
    expect(provider.secrets.get("a")).toBe("token-value-3");
    expect(provider.secrets.get("b")).toBe("token-value-3");
    runtime.close();
  });
});

describe("a resource that is replaced and takes a credential", () => {
  it("rotates the credential when it is reached, and updates the resources before it", async () => {
    const provider = createProvider();
    const types = defineResources(provider, { rotate: true });
    const runtime = createRuntime();
    await runtime.deploy("first", declare(types, { secrets: ["a", "b"] }));
    provider.calls.length = 0;

    // The id is the same, so the token cannot tell that "b" needs a value.
    const [token, a] = declare(types, { secrets: ["a"] });
    const b = new types.Secret("secret:b", {
      config: { name: "b2", Value: (token as any).credentials.Value },
    });
    await runtime.nextProcess("second", [token!, a!, b]);

    expect(provider.calls).toEqual([
      "rotate token-0",
      "update a",
      "delete b",
      "create b2",
    ]);
    expect(provider.secrets.get("a")).toBe("token-value-2");
    expect(provider.secrets.get("b2")).toBe("token-value-2");

    provider.calls.length = 0;
    await runtime.nextProcess("third", [
      ...declare(types, { secrets: ["a"] }).slice(0, 2),
      b,
    ]);
    expect(provider.calls).toEqual([]);
    runtime.close();
  });

  it("fails without rotate, and the next deploy replaces the credential's resource", async () => {
    const provider = createProvider();
    const types = defineResources(provider, { rotate: false });
    const runtime = createRuntime();
    await runtime.deploy("first", declare(types, { secrets: ["a", "b"] }));
    const renamed = () => {
      const [token, a] = declare(types, { secrets: ["a"] });
      return [
        token!,
        a!,
        new types.Secret("secret:b", {
          config: { name: "b2", Value: (token as any).credentials.Value },
        }),
      ];
    };

    await expect(runtime.nextProcess("second", renamed())).rejects.toThrow(
      "Deploy again, and deploy replaces token to get a new one.",
    );
    expect(provider.secrets.get("b")).toBe("token-value-1");

    await runtime.nextProcess("third", renamed());
    expect(provider.secrets.get("a")).toBe("token-value-2");
    expect(provider.secrets.get("b2")).toBe("token-value-2");
    expect(provider.secrets.has("b")).toBe(false);
    runtime.close();
  });
});

describe("a plan with a resource that is replaced and takes a credential", () => {
  const renamed = (types: ReturnType<typeof defineResources>) => {
    const [token, a] = declare(types, { secrets: ["a"] });
    return [
      token!,
      a!,
      new types.Secret("secret:b", {
        config: { name: "b2", Value: (token as any).credentials.Value },
      }),
    ];
  };

  it("shows the rotation, and the update of the resources before it", async () => {
    const types = defineResources(createProvider(), { rotate: true });
    const runtime = createRuntime();
    await runtime.deploy("first", declare(types, { secrets: ["a", "b"] }));

    const plan = await createPlan({
      resources: renamed(types),
      state: runtime.state,
    });

    const [token, a, b] = plan.nodes;
    expect(token).toMatchObject({ decision: "noop", rotates: ["Value"] });
    expect(a).toMatchObject({ decision: "update" });
    expect(b).toMatchObject({ decision: "replace" });
    expect(b!.unheldCredentials).toBeUndefined();
    runtime.close();
  });

  it("shows that deploy fails at the resource without rotate", async () => {
    const types = defineResources(createProvider(), { rotate: false });
    const runtime = createRuntime();
    await runtime.deploy("first", declare(types, { secrets: ["a", "b"] }));

    const plan = await createPlan({
      resources: renamed(types),
      state: runtime.state,
    });

    const [token, a, b] = plan.nodes;
    expect(token).toMatchObject({ decision: "noop" });
    expect(token!.rotates).toBeUndefined();
    expect(a).toMatchObject({ decision: "noop" });
    expect(b).toMatchObject({
      decision: "replace",
      unheldCredentials: [{ resource: "token", name: "Value" }],
    });
    runtime.close();
  });
});

describe("a create that returns a credential its validator rejects", () => {
  it("fails with the credential's name, and records the resource", async () => {
    const Token = resource<{
      Key: { id: string };
      CreateParams: {};
      UpdateParams: {};
      ReadResult: {};
    }>({ type: "test/credentials/InvalidToken", provider: "test" })
      .defineSchema({
        id: {
          propertyType: "computed",
          presence: "required",
          primaryKey: true,
          value: v.string(),
        },
        Value: {
          propertyType: "credential",
          value: v.pipe(v.string(), v.minLength(20)),
        },
      } as const)
      .defineOperations({
        create: async () => ({ id: "token-0", Value: "short-value" }),
        delete: async () => {},
      });
    const runtime = createRuntime();

    const error = await runtime
      .deploy("first", [new Token("token", { config: {} })])
      .catch((e: Error) => e);

    expect((error as Error).message).toContain(
      "create returned a value that its validator rejects for these credentials: Value",
    );
    expect((error as Error).message).not.toContain("short-value");
    expect((await runtime.state.get("token"))?.output.id).toBe("token-0");
    runtime.close();
  });
});

describe("a deploy that is resumed after it created a credential", () => {
  const crashAfterStep = "notation:deploy:token:create:remote:effect:0";

  it("rotates the credential for the resource that takes it", async () => {
    const provider = createProvider();
    const types = defineResources(provider, { rotate: true });
    const runtime = createRuntime({ crashAfterStep });
    const resources = declare(types, { secrets: ["a"] });
    await expect(runtime.deploy("first", resources)).rejects.toThrow(
      "simulated process crash",
    );

    await runtime.nextProcess("first", declare(types, { secrets: ["a"] }));

    expect(provider.calls).toEqual([
      "create token-0",
      "rotate token-0",
      "create a",
    ]);
    expect(provider.secrets.get("a")).toBe("token-value-2");
    expect(runtime.dump()).not.toContain("token-value");

    provider.calls.length = 0;
    await runtime.nextProcess("second", declare(types, { secrets: ["a"] }));
    expect(provider.calls).toEqual([]);
    runtime.close();
  });

  it("fails without rotate, and the next deploy replaces the credential's resource", async () => {
    const provider = createProvider();
    const types = defineResources(provider, { rotate: false });
    const runtime = createRuntime({ crashAfterStep });
    await expect(
      runtime.deploy("first", declare(types, { secrets: ["a"] })),
    ).rejects.toThrow("simulated process crash");

    await expect(
      runtime.nextProcess("first", declare(types, { secrets: ["a"] })),
    ).rejects.toThrow("Deploy again");

    await runtime.nextProcess("second", declare(types, { secrets: ["a"] }));
    expect(provider.secrets.get("a")).toBe("token-value-2");
    runtime.close();
  });
});

describe("an update that does not change a credential", () => {
  it("does not rotate it", async () => {
    const provider = createProvider();
    const types = defineResources(provider, { rotate: true });
    const runtime = createRuntime();
    await runtime.deploy("first", declare(types, { secrets: ["a"] }));
    provider.calls.length = 0;

    await runtime.nextProcess(
      "second",
      declare(types, { secrets: [{ name: "a", label: "new" }] }),
    );

    expect(provider.calls).toEqual(["update a"]);
    expect(provider.secrets.get("a")).toBe("token-value-1");
    runtime.close();
  });
});

class CrashAfterWriteHeap implements HeapClient {
  #crashed = false;

  constructor(
    private readonly inner: HeapClient,
    private readonly crashAfterStep: string,
  ) {}

  readStep(params: { executionId: string; stepKey: string }) {
    return this.inner.readStep(params);
  }

  recordCancellation(params: Parameters<HeapClient["recordCancellation"]>[0]) {
    return this.inner.recordCancellation(params);
  }

  async writeStep(params: Parameters<HeapClient["writeStep"]>[0]) {
    const result = await this.inner.writeStep(params);
    if (
      !this.#crashed &&
      params.stepKey === this.crashAfterStep &&
      params.done
    ) {
      this.#crashed = true;
      throw new Error("simulated process crash");
    }
    return result;
  }
}

function createRuntime(options: { crashAfterStep?: string } = {}) {
  const database = createSqliteDb({ path: ":memory:" });
  let skew = 0;
  const sqliteRuntime = new SqliteRuntime(database, {
    clock: () => Date.now() + skew,
  });
  const runtime: Runtime = {
    clock: sqliteRuntime.clock,
    executions: sqliteRuntime.executions,
    effects: sqliteRuntime.effects,
    heap: options.crashAfterStep
      ? new CrashAfterWriteHeap(sqliteRuntime.heap, options.crashAfterStep)
      : sqliteRuntime.heap,
    stores: sqliteRuntime.stores,
    joins: sqliteRuntime.joins,
  };
  const state = new durable.DurableStateBackend(
    sqliteRuntime.stores,
    "credentials",
  );
  let resources: BaseResource[] = [];
  const router = createWorkflowRouter({
    deploy: workflow(async function* (step, event) {
      yield* durable.deploy(step, {
        executionId: event.executionId,
        resources,
        state,
        driftDetection: false,
        nameScope: { app: "shop", stage: "prod" },
      });
    }),
  });
  const runner = new WorkflowRunner(runtime, {
    router,
    logger: pino({ level: "silent" }),
  });

  async function deploy(executionId: string, declared: BaseResource[]) {
    resources = declared;
    if (!(await runtime.executions.get(executionId))) {
      const admission = await runtime.executions.admit({
        executionId,
        workflowId: "deploy",
        params: {},
        context: new Map(),
      });
      if (admission.status === "rejected") throw new Error(admission.message);
    }
    const [lease] = await runtime.executions.claimDue({
      limit: 1,
      duration: 60_000,
      filter: { executionIds: [executionId] },
    });
    if (!lease) throw new Error(`Execution ${executionId} is not due`);
    let outcome;
    try {
      outcome = await runner.run(
        { workflowId: "deploy", executionId, params: {}, context: new Map() },
        { lease, signal: new AbortController().signal },
      );
    } catch (error) {
      await runtime.executions.release({ lease });
      skew += REDELIVERY_DELAY_BASE;
      throw error;
    }
    await runtime.executions.acknowledge({ lease, outcome });
    if (outcome.status === "failed") throw outcome.error;
    return outcome;
  }

  return {
    state,
    deploy,
    /** Deploys as a new process does, which holds no credential. */
    nextProcess(executionId: string, declared: BaseResource[]) {
      clearHeldCredentials();
      return deploy(executionId, declared);
    },
    /** Every row of every table, as text. */
    dump(): string {
      const tables = database
        .query<{ name: string }>(
          "select name from sqlite_master where type = 'table'",
        )
        .all();
      return tables
        .map(({ name }) =>
          JSON.stringify(
            database.query(`select * from "${name}"`).all(),
            (_key, value) =>
              value instanceof Uint8Array
                ? Buffer.from(value).toString("utf8")
                : typeof value === "bigint"
                  ? String(value)
                  : value,
          ),
        )
        .join("\n");
    },
    close() {
      database.close();
    },
  };
}
