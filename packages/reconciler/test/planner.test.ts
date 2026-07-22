import { resource } from "@notation/resource";
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
    const state = new MemoryStateBackend();
    await state.update("orphan", 0, {
      id: "orphan",
      type: TestResource.type,
      config: {},
      params: {},
      output: {},
      lastOperation: "create",
      lastOperationAt: "2026-07-22T00:00:00.000Z",
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

  it("honours the message constraint in not-found matchers", async () => {
    const TestResource = resource({ type: "test/planner/not-found" })
      .defineSchema({})
      .defineOperations({
        create: async () => undefined,
        read: async () => {
          const error = new Error("access denied");
          error.name = "ProviderError";
          throw error;
        },
        delete: async () => undefined,
        notFoundOnError: [
          {
            name: "ProviderError",
            message: "not found",
            reason: "resource does not exist",
          },
        ],
      });
    const state = new MemoryStateBackend();
    await state.update("existing", 0, {
      id: "existing",
      type: TestResource.type,
      config: {},
      params: {},
      output: {},
      lastOperation: "create",
      lastOperationAt: "2026-07-22T00:00:00.000Z",
    });

    await expect(
      createPlan({
        resources: [new TestResource({ id: "existing" })],
        state,
      }),
    ).rejects.toThrow("access denied");
  });
});
