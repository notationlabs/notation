import { describe, expect, it } from "vitest";
import { resource } from "src/orchestrator/resource";
import {
  createResourceRegistry,
  resolveResourceClass,
} from "src/provisioner/resource-registry";

const TestResource = resource({ type: "test/service/resource" })
  .defineSchema({})
  .defineOperations({
    create: async () => undefined,
    delete: async () => undefined,
  });

describe("provisioner resource registry", () => {
  it("returns undefined when a resource type is not registered", () => {
    const registry = createResourceRegistry([TestResource]);

    expect(
      resolveResourceClass(registry, "test/service/unknown"),
    ).toBeUndefined();
  });
});
