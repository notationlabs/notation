import {
  ResourceNotFoundError,
  ResourceOperationPendingError,
  resource,
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
        lastOperation: "create",
        lastOperationAt: "2026-07-22T00:00:00.000Z",
      },
    });

    const plan = await createPlan({
      resources: [new TestResource({ id: "desired" })],
      state,
      driftDetection: false,
    });

    expect(plan.nodes).toEqual([
      expect.objectContaining({ id: "desired", decision: "create" }),
      expect.objectContaining({ id: "orphan", decision: "delete-orphan" }),
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
        resources: [new TestResource({ id: "existing" })],
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
      resources: [new TestResource({ id: "existing" })],
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
      resources: [new TestResource({ id: "existing" })],
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
        name: { presence: "required", propertyType: "param", primaryKey: true },
        path: { presence: "required", propertyType: "param", immutable: true },
      } as any)
      .defineOperations({
        create: async () => undefined,
        update: async () => undefined,
        delete: async () => undefined,
      });
    // No update: any change replaces it.
    const Attachment = resource({ type: "test/planner/attachment" })
      .defineSchema({
        roleName: { presence: "required", propertyType: "param" },
        policyArn: { presence: "required", propertyType: "param" },
      } as any)
      .defineOperations({
        create: async () => undefined,
        delete: async () => undefined,
      })
      .requireDependencies<{ role: InstanceType<typeof Role> }>()
      .deriveParams(({ deps }) => ({
        roleName: (deps.role.output as any).name,
      }));
    const record = (
      id: string,
      type: string,
      params: Record<string, unknown>,
    ) => ({
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
    const role = new Role({
      id: "role",
      config: { name: "app", path: "/service/" } as any,
    });
    const attachment = new Attachment({
      id: "attachment",
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
});
