import { describe, expect, it, vi, afterEach } from "vitest";
import { createResource } from "src/provisioner/operations/operation.create";
import { State, StateNode } from "src/provisioner/state";
import {
  TestResourceSchema,
  testResourceConfig,
  testOperations,
  testResourceOutput,
} from "test/orchestrator/resource.doubles";

const stateMock = {
  get: vi.fn((id: number) => Promise.resolve({}) as any as StateNode),
  update: vi.fn((id: number, patch: any) => Promise.resolve()),
  delete: vi.fn((id: number) => Promise.resolve()),
  values: vi.fn(() => [] as StateNode[]),
} as any as State;

afterEach(() => {
  Object.values(stateMock).forEach((fn) => fn.mockClear());
});

describe("resource creation", () => {
  const readResult = { ...testResourceOutput, volatileComputed: "123" };
  const createMock = vi.fn(() => Promise.resolve({ primaryKey: "" }));
  const readMock = vi.fn(() => Promise.resolve(readResult));

  const TestResource = TestResourceSchema.defineOperations({
    ...testOperations,
    create: createMock,
    read: readMock,
  });

  const testResource = new TestResource({
    id: "test-resource",
    config: testResourceConfig,
  });

  it("passes computed input to resource.create", async () => {
    await createResource({
      resource: testResource,
      state: stateMock,
      quiet: true,
    });
    const params = await testResource.getParams();
    expect(createMock.mock.calls[0]).toEqual([params]);
  });

  it("updates the state", async () => {
    await createResource({
      resource: testResource,
      state: stateMock,
      quiet: true,
    });
    expect(stateMock.update).toHaveBeenCalledOnce();
  });

  it("sets the resource output with the read result", async () => {
    await createResource({
      resource: testResource,
      state: stateMock,
      quiet: true,
    });
    expect(testResource.output).not.toEqual(testResourceOutput);
    expect(testResource.output).toEqual(readResult);
  });
});
