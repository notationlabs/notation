import type { BaseResource } from "./resource";
import type { NameScope } from "./physical-name";
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
  // Checks of config by async validators, started when resources were
  // declared. Collection fails with the first that fails.
  pendingValidations: Promise<void>[];
  declarationChecks: boolean;
  // The app and stage that resource packages put in physical names. Unset
  // when the graph is collected without a deployment, as `notation viz` does.
  scope?: NameScope;
  // The values of `perCollection` stores, by key.
  stores: Map<string, unknown>;
};

export type CollectOptions = {
  scope?: NameScope;
  /**
   * Whether resources check their config when declared. Defaults to true.
   * Code that does not use config, such as destroy, turns the checks off so
   * that config which fails them does not block it.
   */
  declarationChecks?: boolean;
};

const loadedKey = Symbol.for("@notation/resource/loaded");

/**
 * Records that the copy of this package at `url` is loaded, and throws if
 * another copy is. Each copy has its own collection, so resources made
 * through a second copy would be missing from the graph.
 */
export function claimSingleCopy(url: string) {
  const registry = globalThis as { [loadedKey]?: string };
  const loaded = registry[loadedKey];
  if (loaded === undefined) registry[loadedKey] = url;
  else if (loaded !== url) {
    throw new Error(
      `Two versions of @notation/resource were detected at ${loaded} and ${url}. Please install one version (for example with npm dedupe).`,
    );
  }
}

claimSingleCopy((import.meta as ImportMeta & { url: string }).url);

let activeCollection: ResourceCollection | undefined;

/**
 * Evaluates infra and returns the resources it made. Once `evaluate` is
 * done, the callbacks registered with `onEvaluationEnd` run in the order they
 * were registered, and then contributions close.
 *
 * `opts.scope` names the deployment's app and stage, which scope the
 * physical names of the resources that `evaluate` declares.
 */
export async function collectResourceGraph(
  evaluate: () => unknown | Promise<unknown>,
  opts: CollectOptions = {},
): Promise<ResourceGraph> {
  if (activeCollection) {
    throw new Error("A resource graph is already being collected.");
  }

  const collection: ResourceCollection = {
    graph: { resourceGroups: [], resources: [] },
    closed: false,
    endOfEvaluation: [],
    pendingValidations: [],
    declarationChecks: opts.declarationChecks ?? true,
    scope: opts.scope,
    stores: new Map(),
  };

  activeCollection = collection;
  try {
    await evaluate();
    // A callback can register another callback, which joins the end of the
    // queue.
    while (collection.endOfEvaluation.length > 0) {
      await collection.endOfEvaluation.shift()!();
    }
    await Promise.all(collection.pendingValidations);
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
 * Makes a store that holds one value for each resource collection, so that
 * two graphs collected in one process don't see each other's declarations.
 * The returned function gives the value of the graph that is being
 * collected, which `create` makes on first use, or undefined when no graph
 * is being collected. This package is loaded once, so two installed copies
 * of a provider package that pass the same key share the value.
 * @param key Names the store, such as `@notation/cloudflare/workers`.
 */
export function perCollection<T>(
  key: string,
  create: () => T,
): () => T | undefined {
  return () => {
    const stores = activeCollection?.stores;
    if (!stores) return undefined;
    if (!stores.has(key)) stores.set(key, create());
    return stores.get(key) as T;
  };
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
