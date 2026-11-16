import type { ResourceType } from "@notation/resource";
import type { StateNode } from "@notation/state";
import { resolveRecordClass, type ResourceRegistry } from "./resource-registry";

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
  const recordById = new Map(records.map((node) => [node.id, node]));
  return (dependentId: string, dependencyId: string): boolean => {
    const dependent = recordById.get(dependentId);
    const dependency = recordById.get(dependencyId);
    if (!dependent || !dependency) return false;
    return (
      resolveRecordClass(registry, dependent)?.blocksDeleteOf.includes(
        dependency.type as ResourceType,
      ) ?? false
    );
  };
}
