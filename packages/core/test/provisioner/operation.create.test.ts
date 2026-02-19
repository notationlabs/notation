import { describe, expect, it, vi } from "vitest";
import { createResourceOperation, createStepRunner, runOperation } from "@notation/reconciler";
import { MemoryStateBackend } from "@notation/state";
import {
  TestResourceSchema,
  testResourceConfig,
  testOperations,
  testResourceOutput,
} from "test/orchestrator/resource.doubles";

describe("resource creation", () => {
  it("passes computed input to resource.create", async () => {
    const stateBackend = new MemoryStateBackend();
    const readResult = { ...testResourceOutput, volatileComputed: "123" };
    const createMock = vi.fn(async () => ({ primaryKey: "" }));
    const readMock = vi.fn(async () => readResult);

    const TestResource = TestResourceSchema.defineOperations({
      ...testOperations,
      create: createMock,
      read: readMock,
    });

    const testResource = new TestResource({
      id: "test-resource",
      config: testResourceConfig,
    });
    const step = createStepRunner();

    await runOperation(
      createResourceOperation(step, {
        resource: testResource,
        state: stateBackend,
      }),
    );

    const params = await testResource.getParams();
    const persistedOutput = testResource.toState(readResult);

    expect(createMock.mock.calls[0]).toEqual([params]);
    await expect(stateBackend.get(testResource.id)).resolves.toMatchObject({
      id: testResource.id,
      output: persistedOutput,
      lastOperation: "create",
    });
    expect(testResource.output).not.toEqual(testResourceOutput);
    expect(testResource.output).toEqual(readResult);
  });
});
