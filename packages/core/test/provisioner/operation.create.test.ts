import { describe, expect, it, vi } from "vitest";
import { createResourceOperation, createStepRunner, runOperation } from "@notation/reconciler";
import {
  TestResourceSchema,
  testResourceConfig,
  testOperations,
  testResourceOutput,
} from "test/orchestrator/resource.doubles";

describe("resource creation", () => {
  it("passes computed input to resource.create", async () => {
    const stateMock = {
      get: vi.fn(async () => undefined),
      update: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    };
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
        state: stateMock,
      }),
    );

    const params = await testResource.getParams();
    expect(createMock.mock.calls[0]).toEqual([params]);
    expect(stateMock.update).toHaveBeenCalledOnce();
    expect(testResource.output).not.toEqual(testResourceOutput);
    expect(testResource.output).toEqual(readResult);
  });
});
