import * as v from "valibot";
import {
  UNKNOWN_AFTER_APPLY,
  mergeContributions,
  ResourceNotFoundError,
  ResourceOperationPendingError,
  resource,
  type DurableObject,
} from "@notation/resource";
import { MemoryStateBackend } from "@notation/state";
import { describe, expect, it } from "vitest";
import { createPlan } from "../src/planner";

describe("createPlan", () => {
  it("plans desired creates and persisted orphans without mutation execution", async () => {
    const TestResource = resource({ type: "test/planner/resource" })
      .defineSchema({})
      .defineOperations({
        create: async () => undefined,
        delete: async () => undefined,
      });
    const state = new MemoryStateBackend({
      orphan: {
        version: 1,
        id: "orphan",
        type: TestResource.type,
        config: {},
        params: {},
        output: {},
        dependsOn: ["orphan-role"],
        lastOperation: "create",
        lastOperationAt: "2026-07-22T00:00:00.000Z",
      },
    });

    const plan = await createPlan({
      resources: [new TestResource("desired")],
      state,
      driftDetection: false,
    });

    expect(plan.nodes).toEqual([
      expect.objectContaining({ id: "desired", decision: "create" }),
      expect.objectContaining({
        id: "orphan",
        decision: "delete-orphan",
        dependsOn: ["orphan-role"],
      }),
    ]);
  });

  it("propagates unexpected read failures", async () => {
    const TestResource = resource({ type: "test/planner/read-failure" })
      .defineSchema({})
      .defineOperations({
        create: async () => undefined,
        read: async () => {
          throw new Error("access denied");
        },
        delete: async () => undefined,
      });
    const state = new MemoryStateBackend({
      existing: {
        version: 1,
        id: "existing",
        type: TestResource.type,
        config: {},
        params: {},
        output: {},
        lastOperation: "create",
        lastOperationAt: "2026-07-22T00:00:00.000Z",
      },
    });

    await expect(
      createPlan({
        resources: [new TestResource("existing")],
        state,
      }),
    ).rejects.toThrow("access denied");
  });

  it("plans recreation when the resource reports absence", async () => {
    const TestResource = resource({ type: "test/planner/absent" })
      .defineSchema({})
      .defineOperations({
        create: async () => undefined,
        read: async () => {
          throw new ResourceNotFoundError("resource is absent");
        },
        delete: async () => undefined,
      });
    const state = new MemoryStateBackend({
      existing: {
        version: 1,
        id: "existing",
        type: TestResource.type,
        config: {},
        params: {},
        output: {},
        lastOperation: "create",
        lastOperationAt: "2026-07-22T00:00:00.000Z",
      },
    });

    const plan = await createPlan({
      resources: [new TestResource("existing")],
      state,
    });

    expect(plan.nodes[0]).toMatchObject({
      id: "existing",
      decision: "drift-recreate",
    });
  });

  it("waits for a pending read before planning", async () => {
    let attempts = 0;
    const TestResource = resource({ type: "test/planner/pending" })
      .defineSchema({})
      .defineOperations({
        create: async () => undefined,
        read: async () => {
          attempts += 1;
          if (attempts === 1) {
            throw new ResourceOperationPendingError(
              "Waiting for the provider",
              { retryAfterMs: 0 },
            );
          }
          return {};
        },
        delete: async () => undefined,
      });
    const state = new MemoryStateBackend({
      existing: {
        version: 1,
        id: "existing",
        type: TestResource.type,
        config: {},
        params: {},
        output: {},
        lastOperation: "create",
        lastOperationAt: "2026-07-22T00:00:00.000Z",
      },
    });

    const plan = await createPlan({
      resources: [new TestResource("existing")],
      state,
    });

    expect(plan.nodes[0]).toMatchObject({
      id: "existing",
      decision: "noop",
    });
    expect(attempts).toBe(2);
  });

  it("plans a replacement, and its cascade to dependents, from the schema", async () => {
    // Casts: a resource declared without API types constrains every schema
    // key to be a key of an `any` API schema, which no named key satisfies.
    const Role = resource({ type: "test/planner/role" })
      .defineSchema({
        name: {
          presence: "required",
          propertyType: "param",
          primaryKey: true,
          value: v.string(),
        },
        path: {
          presence: "required",
          propertyType: "param",
          immutable: true,
          value: v.string(),
        },
      } as any)
      .defineOperations({
        create: async () => undefined,
        update: async () => undefined,
        delete: async () => undefined,
      });
    // No update: any change replaces it.
    const Attachment = resource({ type: "test/planner/attachment" })
      .defineSchema({
        roleName: {
          presence: "required",
          propertyType: "param",
          value: v.string(),
        },
        policyArn: {
          presence: "required",
          propertyType: "param",
          value: v.string(),
        },
      } as any)
      .defineOperations({
        create: async () => undefined,
        delete: async () => undefined,
      })
      .requireDependencies<{ role: InstanceType<typeof Role> }>()
      .deriveParams(({ deps }) => ({
        roleName: (deps.role.output as any).name,
      }));
    const record = (id: string, type: string, params: DurableObject) => ({
      version: 1,
      id,
      type,
      config: {},
      params,
      output: params,
      lastOperation: "create" as const,
      lastOperationAt: "2026-07-22T00:00:00.000Z",
    });
    const state = new MemoryStateBackend({
      role: record("role", Role.type, { name: "app", path: "/" }),
      attachment: record("attachment", Attachment.type, {
        roleName: "app",
        policyArn: "arn:policy",
      }),
    });
    const role = new Role("role", {
      config: { name: "app", path: "/service/" } as any,
    });
    const attachment = new Attachment("attachment", {
      config: { policyArn: "arn:policy" } as any,
      dependencies: { role },
    });

    const plan = await createPlan({
      resources: [role, attachment],
      state,
      driftDetection: false,
    });

    expect(plan.nodes).toEqual([
      expect.objectContaining({
        id: "role",
        decision: "replace",
        replaceFields: [{ name: "path", known: true }],
      }),
      // The replaced role's name is unknown until it exists again.
      expect.objectContaining({
        id: "attachment",
        decision: "replace",
        replaceFields: [{ name: "roleName", known: false }],
      }),
    ]);
  });
  describe("leaves alone fields it cannot compare", () => {
    // Cast: see above.
    const Role = resource({ type: "test/planner/role-fields" })
      .defineSchema({
        name: {
          presence: "required",
          propertyType: "param",
          primaryKey: true,
          value: v.string(),
        },
        path: {
          presence: "optional",
          propertyType: "param",
          immutable: true,
          value: v.string(),
        },
        boundary: {
          value: v.string(),
          presence: "optional",
          propertyType: "param",
          immutable: true,
        },
      } as any)
      .defineOperations({
        create: async () => undefined,
        update: async () => undefined,
        read: async () => remote,
        delete: async () => undefined,
      });
    let remote: Record<string, unknown> = {};
    const plan = (config: Record<string, unknown>) =>
      createPlan({
        resources: [new Role("role", { config: config as any })],
        state: new MemoryStateBackend({
          role: {
            version: 1,
            id: "role",
            type: Role.type,
            config: {},
            params: { name: "app", boundary: "arn:boundary" },
            output: { name: "app", boundary: "arn:boundary" },
            lastOperation: "create",
            lastOperationAt: "2026-07-22T00:00:00.000Z",
          },
        }),
      });

    it("an optional param left undefined", async () => {
      remote = { name: "app", boundary: "arn:boundary" };
      const result = await plan({
        name: "app",
        path: undefined,
        boundary: "arn:boundary",
      });
      expect(result.nodes[0]).toMatchObject({ decision: "noop" });
    });

    it("a field the read leaves out, or reports for an unset param", async () => {
      remote = { name: "app", path: "/" };
      const result = await plan({ name: "app", boundary: "arn:boundary" });
      expect(result.nodes[0]).toMatchObject({ decision: "noop" });
    });

    it("but replaces on drift in a field both sides have", async () => {
      remote = { name: "app", boundary: "arn:other" };
      const result = await plan({ name: "app", boundary: "arn:boundary" });
      expect(result.nodes[0]).toMatchObject({
        decision: "drift-replace",
        replaceFields: [{ name: "boundary", known: true }],
      });
    });
  });

  it("plans an unknown output value at its own path, and records the implied edge", async () => {
    // Cast: see above.
    const Queue = resource({ type: "test/planner/queue" })
      .defineSchema({
        name: {
          presence: "required",
          propertyType: "param",
          primaryKey: true,
          value: v.string(),
        },
        arn: {
          presence: "required",
          propertyType: "computed",
          value: v.string(),
        },
      } as any)
      .defineOperations({
        create: async () => undefined,
        delete: async () => undefined,
      });
    const Fn = resource({ type: "test/planner/function" })
      .defineSchema({
        name: {
          presence: "required",
          propertyType: "param",
          primaryKey: true,
          value: v.string(),
        },
        env: {
          value: v.record(v.string(), v.string()),
          presence: "optional",
          propertyType: "param",
          collect: mergeContributions,
        },
      } as any)
      .defineOperations({
        create: async () => undefined,
        update: async () => undefined,
        delete: async () => undefined,
      });
    const queue = new Queue("queue", { config: { name: "orders" } as any });
    const fn = new Fn("fn", { config: { name: "f" } as any });
    fn.contribute({ env: { KEEP: "k" } } as any);
    fn.contribute({ env: { QUEUE: (queue as any).outputValue("arn") } } as any);

    const plan = await createPlan({
      resources: [fn, queue],
      state: new MemoryStateBackend({
        fn: {
          version: 1,
          id: "fn",
          type: Fn.type,
          config: {},
          params: { name: "f", env: { KEEP: "k" } },
          output: { name: "f", env: { KEEP: "k" } },
          lastOperation: "create",
          lastOperationAt: "2026-07-22T00:00:00.000Z",
        },
      }),
      driftDetection: false,
    });

    expect(plan.nodes).toEqual([
      expect.objectContaining({ id: "queue", decision: "create" }),
      expect.objectContaining({
        id: "fn",
        decision: "update",
        params: { name: "f", env: { KEEP: "k", QUEUE: UNKNOWN_AFTER_APPLY } },
        diff: {
          added: { env: { QUEUE: UNKNOWN_AFTER_APPLY } },
          deleted: {},
          updated: {},
        },
        dependsOn: ["queue"],
      }),
    ]);
  });

  describe("value validation", () => {
    const Fn = resource<{
      Key: { name: string };
      CreateParams: { name: string; memory: number };
      UpdateParams: { memory: number };
      ReadResult: {};
    }>({ type: "test/planner/validated-fn" })
      .defineSchema({
        name: {
          presence: "required",
          propertyType: "param",
          value: v.string(),
          primaryKey: true,
          immutable: true,
        },
        memory: {
          presence: "required",
          propertyType: "param",
          value: v.pipe(v.number(), v.integer()),
        },
      })
      .defineOperations({
        create: async () => undefined,
        update: async () => undefined,
        read: async () => remote,
        delete: async () => undefined,
        deriveParams: () => ({ memory }),
      });
    let memory = 128;
    let remote: Record<string, unknown> = {};
    const state = () =>
      new MemoryStateBackend({
        fn: {
          version: 1,
          id: "fn",
          type: Fn.type,
          config: {},
          params: { name: "fn", memory: 128 },
          output: { name: "fn", memory: 128 },
          lastOperation: "create",
          lastOperationAt: "2026-07-22T00:00:00.000Z",
        },
      });

    it("rejects a known value that fails its validator", async () => {
      memory = 1.5;
      const plan = createPlan({
        resources: [new Fn("fn", { config: { name: "fn" } })],
        state: state(),
      });
      await expect(plan).rejects.toMatchObject({
        name: "ValueValidationError",
        resourceId: "fn",
        field: "memory",
        point: "plan",
      });
    });

    it("rejects an invalid known value next to an unknown output value", async () => {
      // Cast: see above.
      const Queue = resource({ type: "test/planner/validated-queue" })
        .defineSchema({
          name: {
            presence: "required",
            propertyType: "param",
            primaryKey: true,
            value: v.string(),
          },
          arn: {
            presence: "required",
            propertyType: "computed",
            value: v.string(),
          },
        } as any)
        .defineOperations({
          create: async () => undefined,
          delete: async () => undefined,
        });
      const Env = resource({ type: "test/planner/validated-env" })
        .defineSchema({
          name: {
            presence: "required",
            propertyType: "param",
            primaryKey: true,
            value: v.string(),
          },
          env: {
            value: v.record(v.string(), v.string()),
            presence: "optional",
            propertyType: "param",
            collect: mergeContributions,
          },
        } as any)
        .defineOperations({
          create: async () => undefined,
          delete: async () => undefined,
        });
      const queue = new Queue("queue", { config: { name: "orders" } as any });
      const env = new Env("env", { config: { name: "env" } as any });
      env.contribute({
        env: { QUEUE: (queue as any).outputValue("arn") },
      } as any);
      env.contribute({ env: { PORT: 8080 } } as any);

      const plan = createPlan({
        resources: [env, queue],
        state: new MemoryStateBackend(),
        driftDetection: false,
      });
      await expect(plan).rejects.toMatchObject({
        name: "ValueValidationError",
        resourceId: "env",
        field: "env",
        point: "plan",
        issues: [expect.stringMatching(/^PORT: Invalid type/)],
      });
    });

    it("rejects a malformed read rather than planning drift from it", async () => {
      memory = 128;
      remote = { name: "fn", memory: "128" };
      const plan = createPlan({
        resources: [new Fn("fn", { config: { name: "fn" } })],
        state: state(),
      });
      await expect(plan).rejects.toMatchObject({
        name: "ValueValidationError",
        field: "memory",
        point: "read",
      });
    });
  });
});
