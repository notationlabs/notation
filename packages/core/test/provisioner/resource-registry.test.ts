import { describe, expect, it } from "vitest";
import { resource } from "src/orchestrator/resource";
import {
  createMissingResourceRegistryMatchWarningEvent,
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

  it("creates a structured warning event for orphan skips", () => {
    expect(
      createMissingResourceRegistryMatchWarningEvent({
        workflow: "deploy",
        resourceId: "orphan-id",
        resourceType: "test/service/unknown",
      }),
    ).toEqual({
      level: "warn",
      event: "reconciler.orphan-deletion.skipped",
      reason: "resource-type-not-registered",
      workflow: "deploy",
      resourceId: "orphan-id",
      resourceType: "test/service/unknown",
    });
  });
});
