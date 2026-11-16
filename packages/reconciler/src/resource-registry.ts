import {
  CredentialSource,
  type BaseResource,
  type ResourceClass,
  type ResourceType,
} from "@notation/resource";
import type { StateNode } from "@notation/state";

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

/**
 * The class that deletes the state record `node`. A source's record gets a
 * class whose delete removes only the record, and that needs nothing from the
 * source's provider package. Any other record gets the class of its type, or
 * undefined if the registry has none.
 */
export function resolveRecordClass(
  registry: ResourceRegistry,
  node: Pick<StateNode, "type" | "provider" | "kind">,
): ResourceClass<any, any, any> | undefined {
  if (node.kind === "credential-source") {
    return recordedSourceClass(node.type as ResourceType, node.provider);
  }
  return resolveResourceClass(registry, node.type as ResourceType);
}

function recordedSourceClass(
  type: ResourceType,
  provider: string,
): ResourceClass<any, any, any> {
  const fail = async (): Promise<never> => {
    throw new Error(
      `${type} is the type of a source that is only in state, and can only be deleted`,
    );
  };
  class RecordedSource extends CredentialSource {
    static type = type;
    static provider = provider;
    static blocksDeleteOf = [] as const;
    type = type;
    provider = provider;
    schema = {};
    readSource = fail;
    loadCredential = fail;
  }
  return RecordedSource as unknown as ResourceClass<any, any, any>;
}
