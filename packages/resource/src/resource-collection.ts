import type { BaseResource } from "./resource";
import type { ResourceGroup } from "./resource-group";

export type ResourceGraph = {
  resourceGroups: ResourceGroup[];
  resources: BaseResource[];
};

type ResourceCollection = {
  graph: ResourceGraph;
  nextResourceGroupId: number;
};

let activeCollection: ResourceCollection | undefined;

export async function collectResourceGraph(
  evaluate: () => unknown | Promise<unknown>,
): Promise<ResourceGraph> {
  if (activeCollection) {
    throw new Error("A resource graph is already being collected.");
  }

  const collection: ResourceCollection = {
    graph: { resourceGroups: [], resources: [] },
    nextResourceGroupId: 0,
  };

  activeCollection = collection;
  try {
    await evaluate();
    return collection.graph;
  } finally {
    activeCollection = undefined;
  }
}

export function getActiveResourceCollection(): ResourceCollection | undefined {
  return activeCollection;
}
