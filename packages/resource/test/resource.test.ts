import { describe, expect, it, test, vi } from "vitest";
import {
  ResourceNotFoundError,
  ResourceOperationPendingError,
  resource,
} from "src";
import {
  TestResource,
  testResourceConfig,
  testResourceOutput,
} from "./resource.doubles";

describe("resource basics", () => {
  const TestResource = resource({
    type: "provider/service/resource",
    provider: "test",
  })
    .defineSchema({})
    .defineOperations({} as any);

  const testResource = new TestResource("0");

  test("type", () => {
    expect(TestResource.type).toBe("provider/service/resource");
    expect(testResource.type).toBe("provider/service/resource");
  });

  test("blocksDeleteOf", () => {
    const Child = resource({
      type: "provider/service/child",
      provider: "test",
      blocksDeleteOf: ["provider/service/parent"],
    })
      .defineSchema({})
      .defineOperations({} as any);

    expect(TestResource.blocksDeleteOf).toEqual([]);
    expect(Child.blocksDeleteOf).toEqual(["provider/service/parent"]);
  });

  test("replaceCreatesFirst", () => {
    const Value = resource({
      type: "provider/service/value",
      provider: "test",
      replaceCreatesFirst: true,
    })
      .defineSchema({})
      .defineOperations({} as any);

    expect(testResource.replaceCreatesFirst).toBe(false);
    expect(new Value("value").replaceCreatesFirst).toBe(true);
  });

  test("setOutput", () => {
    testResource.setOutput({ a: 1 });
    expect(testResource.output).toEqual({ a: 1 });
  });
});

describe("resource schema", () => {
  const testResource = new TestResource("test-resource-1", {
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
      const testResource = new TestResource("test-resource-1", {
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

    const childTestResource = new TestResource("test-resource-1", {
      config: testResourceConfig,
    });

    const testResource = new TestResourceWithDeps("test-resource-1", {
      config: testResourceConfig,
      dependencies: { dep1: childTestResource },
    });

    await testResource.getParams();

    const [{ id, config, deps }] = deriveParamsMock.mock.calls[0];
    expect(id).toBe("test-resource-1");
    expect(config).toEqual(testResourceConfig);
    expect(Object.getPrototypeOf(deps.dep1)).toBe(childTestResource);
    expect(deps.dep1.config).toEqual(testResourceConfig);
  });

  it("passes a view of each dependency at plan and at deploy, whatever its config holds", async () => {
    const seen: unknown[] = [];
    const TestResourceWithDeps = TestResource.requireDependencies<{
      dep1: InstanceType<typeof TestResource>;
    }>().deriveParams(({ deps }) => {
      seen.push(deps.dep1);
      return {};
    });
    const dep1 = new TestResource("dep-1", { config: testResourceConfig });
    const testResource = new TestResourceWithDeps("test-resource-1", {
      config: testResourceConfig,
      dependencies: { dep1 },
    });
    dep1.output = {} as any;

    await testResource.planParams();
    await testResource.getParams();

    expect(seen).toHaveLength(2);
    for (const view of seen) {
      expect(view).not.toBe(dep1);
      expect(Object.getPrototypeOf(view)).toBe(dep1);
    }
  });

  it("merges config and intrinsic config", async () => {
    const deriveParamsMock = vi.fn(() => ({
      requiredParam: "preset",
    }));

    const { requiredParam, ...nonIntrinsicConfig } = testResourceConfig;

    const TestResourceWithDeps = TestResource.requireDependencies<{
      dep1: InstanceType<typeof TestResource>;
    }>().deriveParams(deriveParamsMock);

    const childTestResource = new TestResource("test-resource-1", {
      config: testResourceConfig,
    });

    const testResource = new TestResourceWithDeps("test-resource-1", {
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

describe("resource operation signals", () => {
  it("recognises a not-found signal structurally", () => {
    expect(ResourceNotFoundError.is(new ResourceNotFoundError("missing"))).toBe(
      true,
    );
    expect(
      ResourceNotFoundError.is(
        Object.assign(new Error("missing"), {
          _tag: "ResourceNotFoundError",
        }),
      ),
    ).toBe(true);
  });

  it("recognises a pending signal structurally", () => {
    const fromElsewhere = Object.assign(new Error("waiting"), {
      _tag: "ResourceOperationPendingError",
      retryAfterMs: 2_000,
      callbackContext: { operationId: "abc" },
    });
    expect(ResourceOperationPendingError.is(fromElsewhere)).toBe(true);
  });

  it("rejects unrelated errors", () => {
    expect(ResourceNotFoundError.is(new Error("boom"))).toBe(false);
    expect(ResourceOperationPendingError.is(new Error("boom"))).toBe(false);
    expect(
      ResourceOperationPendingError.is({
        _tag: "ResourceOperationPendingError",
      }),
    ).toBe(false);
  });

  it("carries retry instructions and callback context", () => {
    const pending = new ResourceOperationPendingError("waiting", {
      retryAfterMs: 1_500,
      callbackContext: { operationId: "abc" },
    });
    expect(pending.retryAfterMs).toBe(1_500);
    expect(pending.callbackContext).toEqual({ operationId: "abc" });
  });

  it("rejects an invalid retry delay", () => {
    expect(
      () => new ResourceOperationPendingError("waiting", { retryAfterMs: -1 }),
    ).toThrowError("retryAfterMs must be a non-negative number");
  });
});
