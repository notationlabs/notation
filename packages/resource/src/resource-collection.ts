import type { BaseResource } from "./resource";
import type { ResourceGroup } from "./resource-group";

export type ResourceGraph = {
  resourceGroups: ResourceGroup[];
  resources: BaseResource[];
};

export type ResourceCollection = {
  graph: ResourceGraph;
  // Set once evaluation has ended. Contributions to a resource made in this
  // collection are rejected from then on.
  closed: boolean;
  endOfEvaluation: Array<() => unknown | Promise<unknown>>;
};

let activeCollection: ResourceCollection | undefined;

/**
 * Evaluates infra and returns the resources it made. Once `evaluate` is
 * done, the callbacks registered with `onEvaluationEnd` run in the order they
 * were registered, and then contributions close.
 */
export async function collectResourceGraph(
  evaluate: () => unknown | Promise<unknown>,
): Promise<ResourceGraph> {
  if (activeCollection) {
    throw new Error("A resource graph is already being collected.");
  }

  const collection: ResourceCollection = {
    graph: { resourceGroups: [], resources: [] },
    closed: false,
    endOfEvaluation: [],
  };

  activeCollection = collection;
  try {
    await evaluate();
    // A callback can register another callback, which joins the end of the
    // queue.
    while (collection.endOfEvaluation.length > 0) {
      await collection.endOfEvaluation.shift()!();
    }
    return collection.graph;
  } finally {
    collection.closed = true;
    activeCollection = undefined;
  }
}

export function getActiveResourceCollection(): ResourceCollection | undefined {
  return activeCollection;
}

/**
 * Registers a callback to run when evaluation ends, before contributions
 * close. It is for generated code that contributes values that do not exist
 * while modules are still being evaluated. It is an engine mechanism, not
 * user-facing API.
 */
export function onEvaluationEnd(
  callback: () => unknown | Promise<unknown>,
): void {
  if (!activeCollection) {
    throw new Error(
      "onEvaluationEnd can only be called while a resource graph is being collected.",
    );
  }
  activeCollection.endOfEvaluation.push(callback);
}
