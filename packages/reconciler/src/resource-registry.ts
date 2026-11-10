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

/** Later registries override earlier ones. */
export function mergeResourceRegistries(
  ...registries: (ResourceRegistry | undefined)[]
): ResourceRegistry {
  const merged: ResourceRegistry = new Map();
  for (const registry of registries) {
    for (const [type, Resource] of registry ?? []) merged.set(type, Resource);
  }
  return merged;
}

/** The caller's registry merged with the classes in code. Classes in code win. */
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
