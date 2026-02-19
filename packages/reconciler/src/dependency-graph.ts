import type { BaseResource } from "@notation/resource";

export type ResourceDepthLevels = BaseResource[][];

function asDependencies(resource: BaseResource): BaseResource[] {
  return Object.values(resource.dependencies).filter(
    (dependency): dependency is BaseResource => Boolean(dependency),
  );
}

export function buildResourceDepthLevels(resources: BaseResource[]): ResourceDepthLevels {
  const resourceById = new Map<string, BaseResource>();
  const pendingDependenciesByResourceId = new Map<string, number>();
  const dependentsByResourceId = new Map<string, string[]>();
  const resourceOrder = new Map<string, number>();

  resources.forEach((resource, index) => {
    if (resourceById.has(resource.id)) {
      throw new Error(`Duplicate resource id: ${resource.id}`);
    }

    resourceById.set(resource.id, resource);
    pendingDependenciesByResourceId.set(resource.id, 0);
    dependentsByResourceId.set(resource.id, []);
    resourceOrder.set(resource.id, index);
  });

  for (const resource of resources) {
    const dependencies = asDependencies(resource).filter((dependency) =>
      resourceById.has(dependency.id),
    );
    pendingDependenciesByResourceId.set(resource.id, dependencies.length);

    for (const dependency of dependencies) {
      dependentsByResourceId.get(dependency.id)!.push(resource.id);
    }
  }

  let readyIds = resources
    .filter((resource) => pendingDependenciesByResourceId.get(resource.id) === 0)
    .map((resource) => resource.id);
  const levels: ResourceDepthLevels = [];
  let visitedCount = 0;

  while (readyIds.length > 0) {
    readyIds.sort((a, b) => resourceOrder.get(a)! - resourceOrder.get(b)!);
    const nextReadyIds: string[] = [];
    const level: BaseResource[] = [];

    for (const resourceId of readyIds) {
      const resource = resourceById.get(resourceId)!;
      level.push(resource);
      visitedCount += 1;

      for (const dependentId of dependentsByResourceId.get(resourceId) ?? []) {
        const pending = pendingDependenciesByResourceId.get(dependentId)! - 1;
        pendingDependenciesByResourceId.set(dependentId, pending);
        if (pending === 0) {
          nextReadyIds.push(dependentId);
        }
      }
    }

    levels.push(level);
    readyIds = nextReadyIds;
  }

  if (visitedCount !== resources.length) {
    throw new Error("Resource dependency cycle detected");
  }

  return levels;
}
