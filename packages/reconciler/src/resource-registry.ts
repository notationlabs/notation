import type {
  BaseResource,
  ResourceClass,
  ResourceType,
} from "@notation/resource";

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

/**
 * Where two registries have a class for the same type, the later one's class
 * is kept.
 */
export function mergeResourceRegistries(
  ...registries: (ResourceRegistry | undefined)[]
): ResourceRegistry {
  const merged: ResourceRegistry = new Map();
  for (const registry of registries) {
    for (const [type, Resource] of registry ?? []) merged.set(type, Resource);
  }
  return merged;
}

/**
 * The classes that a workflow can find a record's class in: those that the
 * caller registers, and the classes of the resources in code. A class in code
 * is kept over a registered class of the same type.
 */
export function workflowRegistry(opts: {
  resources: BaseResource[];
  registry?: ResourceRegistry;
}): ResourceRegistry {
  return mergeResourceRegistries(
    opts.registry,
    createResourceRegistryFromResources(opts.resources),
  );
}

export function resolveResourceClass(
  registry: ResourceRegistry,
  type: ResourceType,
): ResourceClass<any, any, any> | undefined {
  return registry.get(type);
}
