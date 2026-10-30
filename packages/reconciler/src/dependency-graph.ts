import type { BaseResource } from "@notation/resource";

export type ResourceDepthLevels = BaseResource[][];

export type DepthLevels<T> = {
  levels: T[][];
  // The items left out of `levels`: members of a cycle, and every item that
  // depends on one. In input order.
  unordered: T[];
};

export function buildResourceDepthLevels(
  resources: BaseResource[],
): ResourceDepthLevels {
  const { levels, unordered } = buildDepthLevels(
    resources,
    (resource) => resource.id,
    (resource) => resource.getDependencies().map((dependency) => dependency.id),
  );

  if (unordered.length > 0) {
    throw new Error("Resource dependency cycle detected");
  }

  return levels;
}

/**
 * Throws when a resource depends on a resource that is not among `resources`
 * and has no output. The graph ignores such an edge, so nothing would deploy
 * the dependency, and the dependent would read an output that never arrives.
 */
export function assertDependenciesPresent(resources: BaseResource[]): void {
  const present = new Set(resources);
  for (const resource of resources) {
    for (const dependency of resource.getDependencies()) {
      if (present.has(dependency) || dependency.output != null) continue;
      throw new Error(
        `${resource.id} depends on ${dependency.id}, which is not part of this deployment. Add ${dependency.id} to a resource group.`,
      );
    }
  }
}

/**
 * Groups items into levels, where each item comes in a later level than every
 * item it depends on. Items keep their input order within a level. An edge to
 * an ID that is not among the items is ignored.
 */
export function buildDepthLevels<T>(
  items: T[],
  idOf: (item: T) => string,
  dependencyIdsOf: (item: T) => string[],
): DepthLevels<T> {
  const itemById = new Map<string, T>();
  const pendingDependenciesById = new Map<string, number>();
  const dependentsById = new Map<string, string[]>();
  const itemOrder = new Map<string, number>();

  items.forEach((item, index) => {
    const id = idOf(item);
    if (itemById.has(id)) {
      throw new Error(`Duplicate resource id: ${id}`);
    }

    itemById.set(id, item);
    pendingDependenciesById.set(id, 0);
    dependentsById.set(id, []);
    itemOrder.set(id, index);
  });

  for (const item of items) {
    const id = idOf(item);
    const dependencyIds = new Set(
      dependencyIdsOf(item).filter((dependencyId) =>
        itemById.has(dependencyId),
      ),
    );
    pendingDependenciesById.set(id, dependencyIds.size);

    for (const dependencyId of dependencyIds) {
      dependentsById.get(dependencyId)!.push(id);
    }
  }

  let readyIds = items
    .map(idOf)
    .filter((id) => pendingDependenciesById.get(id) === 0);
  const levels: T[][] = [];
  const visited = new Set<string>();

  while (readyIds.length > 0) {
    readyIds.sort((a, b) => itemOrder.get(a)! - itemOrder.get(b)!);
    const nextReadyIds: string[] = [];
    const level: T[] = [];

    for (const id of readyIds) {
      level.push(itemById.get(id)!);
      visited.add(id);

      for (const dependentId of dependentsById.get(id) ?? []) {
        const pending = pendingDependenciesById.get(dependentId)! - 1;
        pendingDependenciesById.set(dependentId, pending);
        if (pending === 0) {
          nextReadyIds.push(dependentId);
        }
      }
    }

    levels.push(level);
    readyIds = nextReadyIds;
  }

  return {
    levels,
    unordered: items.filter((item) => !visited.has(idOf(item))),
  };
}
