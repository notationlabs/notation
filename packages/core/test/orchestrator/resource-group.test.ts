import { beforeEach, expect, it } from "vitest";
import { ResourceCollector, ResourceGroup } from "src";
import {
  TestResource,
  TestResource2,
  testResourceConfig,
} from "./resource.doubles";

let collector: ResourceCollector;

beforeEach(() => {
  collector = new ResourceCollector();
});

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

it("creates a resource group", () => {
  const resourceGroup = new TestResourceGroup("test-group", {
    a: 1,
    collector,
  });
  expect(resourceGroup.id).toBe(0);
  expect(resourceGroup.type).toBe("test-group");
  expect(resourceGroup.platform).toBe("test-platform");
  expect(resourceGroup.config).toEqual({ a: 1 });
  expect(resourceGroup.resources).toEqual([]);
});

it("registers resource groups in the collector", () => {
  new TestResourceGroup("test-group", { type: "test1", collector });
  new TestResourceGroup("test-group-2", { type: "test2", collector });

  const groups = collector.getResourceGroups();
  expect(groups).toHaveLength(2);
  expect(groups[0].type).toBe("test-group");
  expect(groups[1].type).toBe("test-group-2");
});

it("creates a resource within a group", () => {
  const resourceGroup = new TestResourceGroup("test-group", { collector });
  const resource = resourceGroup.add(testResource);
  expect(resourceGroup.resources).toContain(resource);
});

it("registers resources in the collector", () => {
  const resourceGroup = new TestResourceGroup("test-group", { collector });
  resourceGroup.add(testResource);
  resourceGroup.add(testResource2);

  const resources = collector.getResources();
  expect(resources).toHaveLength(2);
  expect(resources[0]).toBe(testResource);
  expect(resources[1]).toBe(testResource2);
});

it("increments resource group IDs", () => {
  const rg1 = new TestResourceGroup("test-group", {
    type: "group1",
    collector,
  });
  const rg2 = new TestResourceGroup("test-group", {
    type: "group2",
    collector,
  });

  expect(rg1.id).toBe(0);
  expect(rg2.id).toBe(1);
});

it("finds a resource within a group", () => {
  const resourceGroup = new TestResourceGroup("test-group", {
    type: "group1",
    collector,
  });
  const resource = resourceGroup.add(testResource);

  expect(resourceGroup.findResource(TestResource)).toBe(resource);
  expect(resourceGroup.findResource(TestResource2)).toBe(undefined);
});

it("references resources within groups", () => {
  const rg1 = new TestResourceGroup("test-group", { collector });
  const r1 = rg1.add(testResource);
  const r2 = rg1.add(testResource2);

  expect(collector.getResources()).toContain(r1);
  expect(collector.getResources()).toContain(r2);
});

it("throws an error when adding an existing resource", () => {
  const rg1 = new TestResourceGroup("test-group", { collector });
  rg1.add(testResource);
  expect(() => rg1.add(testResource)).toThrow();
});

it("increments resource IDs globally", () => {
  const rg1 = new TestResourceGroup("test-group", { collector });
  const r1 = rg1.add(testResource);
  const rg2 = new TestResourceGroup("test-group", { collector });
  const r2 = rg2.add(testResource2);
  expect(r1.id).toBe("test-resource-1");
  expect(r2.id).toBe("test-resource-2");
});
