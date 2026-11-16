import type { ResourceType } from "@notation/resource";
import type { StateNode } from "@notation/state";
import {
  resolveResourceClass,
  type ResourceRegistry,
} from "./resource-registry";

/**
 * Whether the record `dependentId` blocks the delete of the record
 * `dependencyId`: the class of the dependent's type lists the type of the
 * dependency in `blocksDeleteOf`. A dependent with no class does not block
 * the delete, and a source never blocks one.
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
    if (dependent.kind === "credential-source") return false;
    return (
      resolveResourceClass(
        registry,
        dependent.type as ResourceType,
      )?.blocksDeleteOf.includes(dependency.type as ResourceType) ?? false
    );
  };
}
