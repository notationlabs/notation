import type {
  BaseResource,
  ResourceClass,
  ResourceType,
} from "@notation/resource";
import type { StateNode } from "@notation/state";
import {
  createResourceRegistryFromResources,
  resolveResourceClass,
  type ResourceRegistry,
} from "./resource-registry";

export type ClassOf = (id: string) => ResourceClass<any, any, any> | undefined;

/**
 * Finds the class of a resource in state or in code. A resource in code has
 * its own class. A resource that is only in state has the registered class of
 * the type in its record.
 */
export function createClassOf(opts: {
  records: StateNode[];
  resources: BaseResource[];
  registry?: ResourceRegistry;
}): ClassOf {
  const resourceById = new Map(
    opts.resources.map((resource) => [resource.id, resource]),
  );
  const recordById = new Map(opts.records.map((node) => [node.id, node]));
  const registry =
    opts.registry ?? createResourceRegistryFromResources(opts.resources);

  return (id) => {
    const resource = resourceById.get(id);
    if (resource) {
      return resource.constructor as unknown as ResourceClass<any, any, any>;
    }
    const type = recordById.get(id)?.type as ResourceType | undefined;
    return type ? resolveResourceClass(registry, type) : undefined;
  };
}

/**
 * Whether `dependentId` blocks the delete of `dependencyId`: the class of the
 * dependent lists the type of the dependency in `blocksDeleteOf`. A dependent
 * with no class does not block the delete.
 */
export function createBlocksDelete(classOf: ClassOf) {
  return (dependentId: string, dependencyId: string): boolean => {
    const type = classOf(dependencyId)?.type;
    if (type === undefined) return false;
    return classOf(dependentId)?.blocksDeleteOf.includes(type) ?? false;
  };
}
