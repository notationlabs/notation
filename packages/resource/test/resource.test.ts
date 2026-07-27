import { expect, it, test, vi } from "vitest";
import { ResourceNotReadyError, resource } from "src";
import {
  TestResource,
  testResourceConfig,
  testResourceOutput,
} from "./resource.doubles";
import { describe } from "node:test";

describe("resource basics", () => {
  const TestResource = resource({ type: "provider/service/resource" })
    .defineSchema({})
    .defineOperations({} as any);

  const testResource = new TestResource({ id: "0" });

  test("type", () => {
    expect(TestResource.type).toBe("provider/service/resource");
    expect(testResource.type).toBe("provider/service/resource");
  });

  test("setOutput", () => {
    testResource.setOutput({ a: 1 });
    expect(testResource.output).toEqual({ a: 1 });
  });
});

describe("resource schema", () => {
  const testResource = new TestResource({
    id: "test-resource-1",
    config: testResourceConfig,
  });

  test("key (primary)", () => {
    testResource.setOutput(testResourceOutput);
    expect(testResource.key).toEqual({ primaryKey: "0" });
  });

  test("key (compound)", () => {
    testResource.setOutput({
      ...testResourceOutput,
      optionalSecondaryKey: 1,
    });
    expect(testResource.key).toEqual({
      primaryKey: "0",
      optionalSecondaryKey: 1,
    });
  });

  test("toComparable removes computed, hidden and volatile fields", () => {
    testResource.setOutput(testResourceOutput);
    const comparableState = testResource.toComparable(testResourceOutput);
    const { primaryKey, hiddenParam, volatileComputed, ...expectedState } =
      testResourceOutput;
    expect(comparableState).toEqual(expectedState);
  });

  test("toState removes hidden params", () => {
    testResource.setOutput(testResourceOutput);
    const state = testResource.toState(testResourceOutput);
    const { hiddenParam, ...expectedState } = testResourceOutput;
    expect(state).toEqual(expectedState);
  });

  test("getParams merges intrinsic config", () => {
    [
      { requiredParam: "name1", hiddenParam: "" },
      { requiredParam: "name1", hiddenParam: "", optionalSecondaryKey: 1 },
    ].forEach(async (params) => {
      const testResource = new TestResource({
        id: "test-resource-1",
        config: params,
      });
      expect(await testResource.getParams()).toEqual({
        ...params,
        intrinsicParam: true,
      });
    });
  });
});

describe("resource dependencies", () => {
  it("passes dependencies to deriveParams", async () => {
    const deriveParamsMock = vi.fn();

    const TestResourceWithDeps = TestResource.requireDependencies<{
      dep1: InstanceType<typeof TestResource>;
    }>().deriveParams(deriveParamsMock);

    const childTestResource = new TestResource({
      id: "test-resource-1",
      config: testResourceConfig,
    });

    const testResource = new TestResourceWithDeps({
      id: "test-resource-1",
      config: testResourceConfig,
      dependencies: { dep1: childTestResource },
    });

    await testResource.getParams();

    expect(deriveParamsMock.mock.calls[0]).toEqual([
      {
        id: "test-resource-1",
        config: testResourceConfig,
        deps: { dep1: childTestResource },
      },
    ]);
  });

  it("merges config and intrinsic config", async () => {
    const deriveParamsMock = vi.fn(() => ({
      requiredParam: "preset",
    }));

    const { requiredParam, ...nonIntrinsicConfig } = testResourceConfig;

    const TestResourceWithDeps = TestResource.requireDependencies<{
      dep1: InstanceType<typeof TestResource>;
    }>().deriveParams(deriveParamsMock);

    const childTestResource = new TestResource({
      id: "test-resource-1",
      config: testResourceConfig,
    });

    const testResource = new TestResourceWithDeps({
      id: "test-resource-1",
      config: nonIntrinsicConfig,
      dependencies: { dep1: childTestResource },
    });

    expect(await testResource.getParams()).toEqual({
      ...testResourceConfig,
      requiredParam: "preset",
      intrinsicParam: true,
    });
  });
});

describe("ResourceNotReadyError", () => {
  it("recognises its own instances", () => {
    expect(ResourceNotReadyError.is(new ResourceNotReadyError("waiting"))).toBe(
      true,
    );
  });

  it("recognises the tag without class identity", () => {
    // A copy thrown from another realm or bundle carries the tag, not the class.
    const fromElsewhere = Object.assign(new Error("waiting"), {
      _tag: "ResourceNotReadyError",
    });
    expect(ResourceNotReadyError.is(fromElsewhere)).toBe(true);
  });

  it("rejects unrelated errors", () => {
    expect(ResourceNotReadyError.is(new Error("boom"))).toBe(false);
    expect(ResourceNotReadyError.is({ _tag: "SomethingElse" })).toBe(false);
    expect(ResourceNotReadyError.is(undefined)).toBe(false);
  });
});
