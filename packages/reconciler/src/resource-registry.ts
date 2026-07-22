import type { BaseResource, ResourceClass, ResourceType } from "@notation/resource";

export type ResourceRegistry = Map<ResourceType, ResourceClass<any, any, any>>;

export type MissingResourceRegistryMatchWarningEvent = {
  level: "warn";
  event: "reconciler.orphan-deletion.skipped";
  reason: "resource-type-not-registered";
  workflow: "deploy" | "refresh" | "destroy";
  resourceId: string;
  resourceType: ResourceType;
};

export function createResourceRegistry(
  entries: Iterable<ResourceClass<any, any, any>> = [],
): ResourceRegistry {
  const registry: ResourceRegistry = new Map();

  for (const Resource of entries) {
    registry.set(Resource.type, Resource);
  }

  return registry;
}

export function createResourceRegistryFromResources(
  resources: BaseResource[],
): ResourceRegistry {
  const registry: ResourceRegistry = new Map();

  for (const resource of resources) {
    registry.set(
      resource.type,
      resource.constructor as unknown as ResourceClass<any, any, any>,
    );
  }

  return registry;
}

export function resolveResourceClass(
  registry: ResourceRegistry,
  type: ResourceType,
): ResourceClass<any, any, any> | undefined {
  return registry.get(type);
}

export function createMissingResourceRegistryMatchWarningEvent(opts: {
  workflow: "deploy" | "refresh" | "destroy";
  resourceId: string;
  resourceType: ResourceType;
}): MissingResourceRegistryMatchWarningEvent {
  return {
    level: "warn",
    event: "reconciler.orphan-deletion.skipped",
    reason: "resource-type-not-registered",
    workflow: opts.workflow,
    resourceId: opts.resourceId,
    resourceType: opts.resourceType,
  };
}
