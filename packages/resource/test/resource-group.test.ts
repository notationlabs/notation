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

function newTestResource() {
  return new TestResource("test-resource-1", { config: testResourceConfig });
}

function newTestResource2() {
  return new TestResource2("test-resource-2", { config: testResourceConfig });
}

it("creates a resource group", async () => {
  const graph = await collectResourceGraph(() => {
    new TestResourceGroup("test-group", "group-a", { a: 1 });
  });
  const resourceGroup = graph.resourceGroups[0] as TestResourceGroup;

  expect(resourceGroup.id).toBe("group-a");
  expect(resourceGroup.type).toBe("test-group");
  expect(resourceGroup.platform).toBe("test-platform");
  expect(resourceGroup.config).toEqual({ a: 1 });
  expect(resourceGroup.resources).toEqual([]);
});

it("keeps the id it is given outside a collection", () => {
  const resourceGroup = new TestResourceGroup("test-group", "group-a");
  expect(resourceGroup.id).toBe("group-a");
});

it("keeps config keys that share a name with group options", async () => {
  const config = { id: "my-fn" };
  const graph = await collectResourceGraph(() => {
    new TestResourceGroup("test-group", "group-a", config);
  });
  const resourceGroup = graph.resourceGroups[0] as TestResourceGroup;

  expect(resourceGroup.id).toBe("group-a");
  expect(resourceGroup.config).toEqual(config);
});

it("defaults config to an empty object", () => {
  const resourceGroup = new TestResourceGroup("test-group", "group-a");
  expect(resourceGroup.config).toEqual({});
});

it("collects resource groups", async () => {
  const graph = await collectResourceGraph(() => {
    new TestResourceGroup("test-group", "group-a");
    new TestResourceGroup("test-group-2", "group-b");
  });

  expect(graph.resourceGroups).toHaveLength(2);
  expect(graph.resourceGroups[0].type).toBe("test-group");
  expect(graph.resourceGroups[1].type).toBe("test-group-2");
});

it("throws when an id is reused within a type", async () => {
  await expect(
    collectResourceGraph(() => {
      new TestResourceGroup("test-group", "group-a");
      new TestResourceGroup("test-group", "group-a");
    }),
  ).rejects.toThrow(
    'Duplicate test-group id "group-a": another test-group group in this deployment already uses it.',
  );
});

it("allows an id to be reused across types", async () => {
  const graph = await collectResourceGraph(() => {
    new TestResourceGroup("test-group", "group-a");
    new TestResourceGroup("test-group-2", "group-a");
  });

  expect(graph.resourceGroups).toHaveLength(2);
});

it("creates a resource within a group", () => {
  const resourceGroup = new TestResourceGroup("test-group", "group-a");
  const resource = resourceGroup.add(newTestResource());
  expect(resourceGroup.resources).toContain(resource);
});

it("records the group on the resources it adds", () => {
  const resource = new TestResource("grouped", {
    config: testResourceConfig,
  });
  expect(resource.group).toBeNull();

  new TestResourceGroup("test-group", "group-a").add(resource);
  expect(resource.group).toEqual({
    type: "test-group",
    id: "group-a",
    parents: [],
  });
});

it("collects resources", async () => {
  const testResource = newTestResource();
  const testResource2 = newTestResource2();
  const graph = await collectResourceGraph(() => {
    const resourceGroup = new TestResourceGroup("test-group", "group-a");
    resourceGroup.add(testResource);
    resourceGroup.add(testResource2);
  });

  expect(graph.resources).toEqual([testResource, testResource2]);
});

it("collects a resource that is in no group", async () => {
  let resource!: InstanceType<typeof TestResource>;
  const graph = await collectResourceGraph(() => {
    resource = new TestResource("loose", { config: testResourceConfig });
  });

  expect(graph.resources).toEqual([resource]);
  expect(resource.group).toBeNull();
});

it("sets the group of a collected resource when a group adds it", async () => {
  let first!: InstanceType<typeof TestResource>;
  let second!: InstanceType<typeof TestResource>;
  let group!: TestResourceGroup;
  const graph = await collectResourceGraph(() => {
    first = new TestResource("first", { config: testResourceConfig });
    second = new TestResource("second", { config: testResourceConfig });
    group = new TestResourceGroup("test-group", "group-a");
    group.add(second);
  });

  expect(graph.resources).toEqual([first, second]);
  expect(group.resources).toEqual([second]);
  expect(first.group).toBeNull();
  expect(second.group).toEqual({
    type: "test-group",
    id: "group-a",
    parents: [],
  });
});

it("throws when a collected resource is added to two groups", async () => {
  await expect(
    collectResourceGraph(() => {
      const resource = new TestResource("shared", {
        config: testResourceConfig,
      });
      new TestResourceGroup("test-group", "group-a").add(resource);
      new TestResourceGroup("test-group", "group-b").add(resource);
    }),
  ).rejects.toThrow("has already been registered");
});

it("throws when a collected resource is added to a group twice", async () => {
  await expect(
    collectResourceGraph(() => {
      const group = new TestResourceGroup("test-group", "group-a");
      const resource = new TestResource("twice", {
        config: testResourceConfig,
      });
      group.add(resource);
      group.add(resource);
    }),
  ).rejects.toThrow("has already been registered");
});

it("leaves out a resource made with no collection active", async () => {
  const outside = new TestResource("outside", { config: testResourceConfig });
  const graph = await collectResourceGraph(() => {});

  expect(graph.resources).toEqual([]);
  expect(outside.group).toBeNull();
});

it("throws an error when adding an existing resource", () => {
  const resourceGroup = new TestResourceGroup("test-group", "group-a");
  const testResource = newTestResource();
  resourceGroup.add(testResource);
  expect(() => resourceGroup.add(testResource)).toThrow();
});

it("throws when a resource made with no collection active is added to two groups", () => {
  const resource = new TestResource("shared", { config: testResourceConfig });
  new TestResourceGroup("test-group", "group-a").add(resource);

  expect(() =>
    new TestResourceGroup("test-group", "group-b").add(resource),
  ).toThrow(
    'Resource provider/service/resource "shared" has already been registered in group test-group "group-a".',
  );
});

it("adds a resource once per id", () => {
  const resourceGroup = new TestResourceGroup("test-group", "group-a");
  const opts = { config: testResourceConfig };
  const first = resourceGroup.addOnce(TestResource, "binding", opts);
  const second = resourceGroup.addOnce(TestResource, "binding", opts);

  expect(second).toBe(first);
  expect(resourceGroup.resources).toEqual([first]);
});

it("throws when an id is reused for a different resource type", () => {
  const resourceGroup = new TestResourceGroup("test-group", "group-a");
  const opts = { config: testResourceConfig };
  resourceGroup.addOnce(TestResource, "binding", opts);

  expect(() => resourceGroup.addOnce(TestResource2, "binding", opts)).toThrow();
});

it("adds a group to a group", async () => {
  let outer!: TestResourceGroup;
  let inner!: TestResourceGroup;
  let resource!: InstanceType<typeof TestResource>;
  const graph = await collectResourceGraph(() => {
    outer = new TestResourceGroup("outer", "o");
    inner = new TestResourceGroup("inner", "i");
    resource = new TestResource("nested", { config: testResourceConfig });
    expect(outer.add(inner)).toBe(inner);
    inner.add(resource);
  });

  expect(graph.resourceGroups).toEqual([outer, inner]);
  expect(graph.resources).toEqual([resource]);
  expect(outer.groups).toEqual([inner]);
  expect(outer.resources).toEqual([]);
  expect(outer.parent).toBeNull();
  expect(inner.parent).toEqual({ type: "outer", id: "o", parents: [] });
  expect(inner.ref).toEqual({
    type: "inner",
    id: "i",
    parents: [{ type: "outer", id: "o" }],
  });
  expect(resource.group).toEqual(inner.ref);
});

it("nests groups three levels deep", () => {
  const a = new TestResourceGroup("level", "a");
  const b = new TestResourceGroup("level", "b");
  const c = new TestResourceGroup("level", "c");
  const resource = c.add(newTestResource());
  b.add(c);
  a.add(b);

  expect(c.parent).toEqual({
    type: "level",
    id: "b",
    parents: [{ type: "level", id: "a" }],
  });
  expect(resource.group).toEqual({
    type: "level",
    id: "c",
    parents: [
      { type: "level", id: "a" },
      { type: "level", id: "b" },
    ],
  });
});

it("updates the ref of a resource when its group is added to a parent later", async () => {
  let resource!: InstanceType<typeof TestResource>;
  await collectResourceGraph(() => {
    const inner = new TestResourceGroup("inner", "i");
    resource = inner.add(newTestResource());
    expect(resource.group).toEqual({ type: "inner", id: "i", parents: [] });
    new TestResourceGroup("outer", "o").add(inner);
  });

  expect(resource.group).toEqual({
    type: "inner",
    id: "i",
    parents: [{ type: "outer", id: "o" }],
  });
});

it("throws when a group that has a parent is added to another group", () => {
  const inner = new TestResourceGroup("inner", "i");
  new TestResourceGroup("outer", "a").add(inner);

  expect(() => new TestResourceGroup("outer", "b").add(inner)).toThrow(
    'Group inner "i" has already been added to group outer "a".',
  );
});

it("throws when a group is added to the same group twice", () => {
  const outer = new TestResourceGroup("outer", "o");
  const inner = new TestResourceGroup("inner", "i");
  outer.add(inner);

  expect(() => outer.add(inner)).toThrow("has already been added");
  expect(outer.groups).toEqual([inner]);
});

it("throws when a group is added to itself", () => {
  const group = new TestResourceGroup("test-group", "group-a");

  expect(() => group.add(group)).toThrow(
    'Group test-group "group-a" can\'t be added to itself.',
  );
});

it("throws when a group is added to a group it contains", () => {
  const a = new TestResourceGroup("level", "a");
  const b = new TestResourceGroup("level", "b");
  const c = new TestResourceGroup("level", "c");
  a.add(b);
  b.add(c);

  expect(() => c.add(a)).toThrow(
    'Group level "a" can\'t be added to group level "c", which it contains.',
  );
  expect(a.parent).toBeNull();
});

it("puts a group made outside a collection in the graph when it is added", async () => {
  const inner = new TestResourceGroup("inner", "i");
  const resource = inner.add(newTestResource());
  let outer!: TestResourceGroup;
  const graph = await collectResourceGraph(() => {
    outer = new TestResourceGroup("outer", "o");
    outer.add(inner);
  });

  expect(graph.resourceGroups).toEqual([outer, inner]);
  expect(graph.resources).toEqual([resource]);
});

it("throws when a group made outside a collection reuses an id in it", async () => {
  const inner = new TestResourceGroup("test-group", "group-a");
  await expect(
    collectResourceGraph(() => {
      new TestResourceGroup("test-group", "group-a");
      new TestResourceGroup("outer", "o").add(inner);
    }),
  ).rejects.toThrow('Duplicate test-group id "group-a"');
});

it("keeps a group that no group adds at the top level", async () => {
  const graph = await collectResourceGraph(() => {
    new TestResourceGroup("outer", "o");
    new TestResourceGroup("inner", "i");
  });

  expect(graph.resourceGroups.map((group) => group.parent)).toEqual([
    null,
    null,
  ]);
});

it("isolates consecutive collections", async () => {
  const first = await collectResourceGraph(() => {
    new TestResourceGroup("test-group", "group-a");
  });
  const second = await collectResourceGraph(() => {
    new TestResourceGroup("test-group", "group-a");
  });

  expect(first.resourceGroups).toHaveLength(1);
  expect(second.resourceGroups).toHaveLength(1);
  expect(second.resourceGroups[0]).not.toBe(first.resourceGroups[0]);
});

it("releases collection state after an error", async () => {
  await expect(
    collectResourceGraph(() => {
      new TestResourceGroup("test-group", "group-a");
      throw new Error("failed");
    }),
  ).rejects.toThrow("failed");

  const graph = await collectResourceGraph(() => {
    new TestResourceGroup("test-group", "group-a");
  });

  expect(graph.resourceGroups).toHaveLength(1);
  expect(graph.resourceGroups[0].id).toBe("group-a");
});
