import { expect, it } from "vitest";
import { collectResourceGraph, ResourceGroup } from "src";
import {
  TestResource,
  TestResource2,
  testResourceConfig,
} from "./resource.doubles";

class TestResourceGroup extends ResourceGroup {
  platform = "test-platform";
}

const testResource = new TestResource({
  id: "test-resource-1",
  config: testResourceConfig,
});

const testResource2 = new TestResource2({
  id: "test-resource-2",
  config: testResourceConfig,
});

it("creates a resource group", async () => {
  const graph = await collectResourceGraph(() => {
    new TestResourceGroup("test-group", { config: { a: 1 } });
  });
  const resourceGroup = graph.resourceGroups[0] as TestResourceGroup;

  expect(resourceGroup.id).toBe(0);
  expect(resourceGroup.type).toBe("test-group");
  expect(resourceGroup.platform).toBe("test-platform");
  expect(resourceGroup.config).toEqual({ a: 1 });
  expect(resourceGroup.resources).toEqual([]);
});

it("keeps config keys that share a name with group options", async () => {
  const config = { id: "my-fn", dependencies: ["x"] };
  const graph = await collectResourceGraph(() => {
    new TestResourceGroup("test-group", { config });
  });
  const resourceGroup = graph.resourceGroups[0] as TestResourceGroup;

  expect(resourceGroup.id).toBe(0);
  expect(resourceGroup.dependencies).toEqual({});
  expect(resourceGroup.config).toEqual(config);
});

it("defaults config to an empty object", () => {
  const resourceGroup = new TestResourceGroup("test-group", {});
  expect(resourceGroup.config).toEqual({});
});

it("collects resource groups", async () => {
  const graph = await collectResourceGraph(() => {
    new TestResourceGroup("test-group", { config: { type: "test1" } });
    new TestResourceGroup("test-group-2", { config: { type: "test2" } });
  });

  expect(graph.resourceGroups).toHaveLength(2);
  expect(graph.resourceGroups[0].type).toBe("test-group");
  expect(graph.resourceGroups[1].type).toBe("test-group-2");
});

it("creates a resource within a group", () => {
  const resourceGroup = new TestResourceGroup("test-group", {});
  const resource = resourceGroup.add(testResource);
  expect(resourceGroup.resources).toContain(resource);
});

it("collects resources", async () => {
  const graph = await collectResourceGraph(() => {
    const resourceGroup = new TestResourceGroup("test-group", {});
    resourceGroup.add(testResource);
    resourceGroup.add(testResource2);
  });

  expect(graph.resources).toEqual([testResource, testResource2]);
});

it("increments resource group IDs", async () => {
  const graph = await collectResourceGraph(() => {
    new TestResourceGroup("test-group", { config: { type: "group1" } });
    new TestResourceGroup("test-group", { config: { type: "group2" } });
  });

  expect(graph.resourceGroups[0].id).toBe(0);
  expect(graph.resourceGroups[1].id).toBe(1);
});

it("throws an error when adding an existing resource", () => {
  const resourceGroup = new TestResourceGroup("test-group", {});
  resourceGroup.add(testResource);
  expect(() => resourceGroup.add(testResource)).toThrow();
});

it("adds a resource once per id", () => {
  const resourceGroup = new TestResourceGroup("test-group", {});
  const opts = { id: "binding", config: testResourceConfig };
  const first = resourceGroup.addOnce(TestResource, opts);
  const second = resourceGroup.addOnce(TestResource, opts);

  expect(second).toBe(first);
  expect(resourceGroup.resources).toEqual([first]);
});

it("throws when an id is reused for a different resource type", () => {
  const resourceGroup = new TestResourceGroup("test-group", {});
  const opts = { id: "binding", config: testResourceConfig };
  resourceGroup.addOnce(TestResource, opts);

  expect(() => resourceGroup.addOnce(TestResource2, opts)).toThrow();
});

it("isolates consecutive collections", async () => {
  const first = await collectResourceGraph(() => {
    new TestResourceGroup("first", {});
  });
  const second = await collectResourceGraph(() => {
    new TestResourceGroup("second", {});
  });

  expect(first.resourceGroups[0].id).toBe(0);
  expect(second.resourceGroups[0].id).toBe(0);
  expect(first.resourceGroups[0].type).toBe("first");
  expect(second.resourceGroups[0].type).toBe("second");
});

it("releases collection state after an error", async () => {
  await expect(
    collectResourceGraph(() => {
      new TestResourceGroup("failed", {});
      throw new Error("failed");
    }),
  ).rejects.toThrow("failed");

  const graph = await collectResourceGraph(() => {
    new TestResourceGroup("recovered", {});
  });

  expect(graph.resourceGroups[0].id).toBe(0);
  expect(graph.resourceGroups[0].type).toBe("recovered");
});
