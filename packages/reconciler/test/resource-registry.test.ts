import { describe, expect, it } from "vitest";
import { resource } from "@notation/resource";
import {
  createResourceRegistry,
  createResourceRegistryFromResources,
  resolveResourceClass,
} from "../src/resource-registry";

const TestResourceA = resource({ type: "test/service/a" })
  .defineSchema({})
  .defineOperations({
    create: async () => ({}),
    delete: async () => undefined,
  });

const TestResourceB = resource({ type: "test/service/b" })
  .defineSchema({})
  .defineOperations({
    create: async () => ({}),
    delete: async () => undefined,
  });

describe("resource registry", () => {
  it("registers resource classes by type", () => {
    const registry = createResourceRegistry([TestResourceA, TestResourceB]);

    expect(registry.get(TestResourceA.type)).toBe(TestResourceA);
    expect(registry.get(TestResourceB.type)).toBe(TestResourceB);
  });

  it("creates a registry from resource instances", () => {
    const resourceA = new TestResourceA({ id: "a" });
    const resourceB = new TestResourceB({ id: "b" });

    const registry = createResourceRegistryFromResources([resourceA, resourceB]);

    expect(registry.get(TestResourceA.type)).toBe(TestResourceA);
    expect(registry.get(TestResourceB.type)).toBe(TestResourceB);
  });

  it("returns undefined for missing resource type matches", () => {
    const registry = createResourceRegistry([TestResourceA]);

    expect(resolveResourceClass(registry, "test/service/unknown")).toBeUndefined();
  });
});
