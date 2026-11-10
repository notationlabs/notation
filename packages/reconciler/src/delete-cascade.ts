import type { BaseResource, ResourceType } from "@notation/resource";
import type { StateNode } from "@notation/state";
import {
  createResourceRegistryFromResources,
  type ResourceRegistry,
} from "./resource-registry";

/**
 * The classes that a cascade can find: those that the caller registers, and
 * the classes of the resources in code.
 */
export function cascadeRegistry(opts: {
  resources: BaseResource[];
  registry?: ResourceRegistry;
}): ResourceRegistry {
  return new Map([
    ...(opts.registry ?? []),
    ...createResourceRegistryFromResources(opts.resources),
  ]);
}

/**
 * Whether the record `dependentId` blocks the delete of the record
 * `dependencyId`: the class of the dependent's type lists the type of the
 * dependency in `blocksDeleteOf`. A dependent with no class does not block
 * the delete.
 */
export function createBlocksDelete(
  records: StateNode[],
  registry: ResourceRegistry,
) {
  const typeById = new Map(
    records.map((node) => [node.id, node.type as ResourceType]),
  );
  return (dependentId: string, dependencyId: string): boolean => {
    const dependentType = typeById.get(dependentId);
    const type = typeById.get(dependencyId);
    if (!dependentType || !type) return false;
    return registry.get(dependentType)?.blocksDeleteOf.includes(type) ?? false;
  };
}
