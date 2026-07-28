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
        rev: 1,
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
        rev: 1,
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
        rev: 1,
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
        rev: 1,
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
});
