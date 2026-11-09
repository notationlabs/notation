import type {
  BaseResource,
  ResourceClass,
  ResourceType,
} from "@notation/resource";
import type { StateNode } from "@notation/state";
import { collectDependents } from "./dependency-graph";
import {
  createResourceRegistryFromResources,
  resolveResourceClass,
  type ResourceRegistry,
} from "./resource-registry";

/**
 * Answers, for the resources in state and in code, whether one blocks the
 * delete of another. Plan and deploy both use it, so that they find the same
 * dependents of a replaced resource.
 *
 * A resource in code is described by its own class. A resource that is only
 * in state is described by the registered class of the type in its record.
 * The known classes are the registered classes and the classes of the
 * resources in code.
 */
export type DeleteBlocks = {
  typeOf(id: string): ResourceType | undefined;
  classOf(id: string): ResourceClass<any, any, any> | undefined;
  /**
   * Whether `dependentId` blocks the delete of `dependencyId`: the class of
   * the dependent lists the class of the dependency in `blocksDeleteOf`.
   *
   * A dependent with no class does not block the delete when no known class
   * lists the type of the dependency, as before `blocksDeleteOf` existed.
   * Otherwise it may block the delete, and the answer is undefined.
   */
  blocks(dependentId: string, dependencyId: string): boolean | undefined;
};

export function createDeleteBlocks(opts: {
  records: StateNode[];
  resources: BaseResource[];
  registry?: ResourceRegistry;
}): DeleteBlocks {
  const resourceById = new Map(
    opts.resources.map((resource) => [resource.id, resource]),
  );
  const recordById = new Map(opts.records.map((node) => [node.id, node]));
  const registry =
    opts.registry ?? createResourceRegistryFromResources(opts.resources);

  const typeOf = (id: string) =>
    resourceById.get(id)?.type ??
    (recordById.get(id)?.type as ResourceType | undefined);

  const classOf = (id: string) => {
    const resource = resourceById.get(id);
    if (resource) {
      return resource.constructor as unknown as ResourceClass<any, any, any>;
    }
    const type = typeOf(id);
    return type ? resolveResourceClass(registry, type) : undefined;
  };

  let listedTypes: Set<ResourceType> | undefined;
  const isListed = (type: ResourceType | undefined) => {
    listedTypes ??= new Set(
      [...registry.values(), ...opts.resources]
        .flatMap((Resource) => Resource.blocksDeleteOf)
        .map((Resource) => Resource.type),
    );
    return type !== undefined && listedTypes.has(type);
  };

  return {
    typeOf,
    classOf,
    blocks(dependentId, dependencyId) {
      const type = typeOf(dependencyId);
      const blocked =
        resourceById.get(dependentId)?.blocksDeleteOf ??
        classOf(dependentId)?.blocksDeleteOf;
      if (!blocked) return isListed(type) ? undefined : false;
      return blocked.some((Resource) => Resource.type === type);
    },
  };
}

/**
 * The resources that deploy deletes before it replaces `id`, in delete
 * order. Each depends on `id` by the edges in `edgesById`, or on another of
 * them, and blocks the delete of the resource it depends on.
 *
 * Throws when a dependent has no class and may block the delete, because it
 * cannot tell whether that dependent must be deleted first.
 */
export function collectBlockingDependents(
  id: string,
  edgesById: Map<string, string[]>,
  deleteBlocks: DeleteBlocks,
): string[] {
  return collectDependents(id, edgesById, (dependentId, dependencyId) => {
    const blocks = deleteBlocks.blocks(dependentId, dependencyId);
    if (blocks === undefined) {
      const dependency = dependencyId === id ? "it" : dependencyId;
      throw new Error(
        `Cannot replace ${id}: ${dependentId} depends on ${dependency} in state, and no registered class has its type ${deleteBlocks.typeOf(dependentId)}, so deploy cannot tell whether ${dependentId} must be deleted first. ` +
          `This happens when the last resource of a type is removed in the same deploy that replaces a resource it depends on. ` +
          `Declare a resource of type ${deleteBlocks.typeOf(dependentId)} again, or deploy the change that replaces ${id} before you remove the last resource of that type.`,
      );
    }
    return blocks;
  });
}
