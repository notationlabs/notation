import type {
  BaseResource,
  ResourceClass,
  ResourceType,
} from "src/orchestrator/resource";

export type ResourceRegistry = Map<ResourceType, ResourceClass<any, any, any>>;

export function createResourceRegistry(
  entries: Iterable<ResourceClass<any, any, any>> = [],
): ResourceRegistry {
  const registry: ResourceRegistry = new Map();
  for (const Resource of entries) {
    registry.set(Resource.type, Resource);
  }
  return registry;
}

export function createResourceRegistryFromGraph(
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
): ResourceClass<any, any, any> {
  const Resource = registry.get(type);
  if (!Resource) {
    throw new Error(
      `No resource provider registered for type "${type}". ` +
        `Provide a ResourceRegistry (type -> ResourceClass) to the deploy/refresh workflows ` +
        `so resources can be reconstructed from state for orphan deletion.`,
    );
  }
  return Resource;
}
