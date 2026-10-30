import type { BaseResource } from "@notation/resource";

export type ResourceDepthLevels = BaseResource[][];

export type DepthLevels<T> = {
  levels: T[][];
  // The items left out of `levels`: members of a cycle, and every item that
  // depends on one. In input order.
  unordered: T[];
};

function asDependencies(resource: BaseResource): BaseResource[] {
  return Object.values(resource.dependencies).filter(
    (dependency): dependency is BaseResource => Boolean(dependency),
  );
}

export function buildResourceDepthLevels(
  resources: BaseResource[],
): ResourceDepthLevels {
  const { levels, unordered } = buildDepthLevels(
    resources,
    (resource) => resource.id,
    (resource) => asDependencies(resource).map((dependency) => dependency.id),
  );

  if (unordered.length > 0) {
    throw new Error("Resource dependency cycle detected");
  }

  return levels;
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
