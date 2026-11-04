import type { BaseResource } from "./resource";
import type { NameScope } from "./physical-name";
import type { ResourceGroup } from "./resource-group";
import type { RuntimeFunction, RuntimeRegistry } from "./runtime-link";

export type ResourceGraph = {
  resourceGroups: ResourceGroup[];
  resources: BaseResource[];
  /**
   * The functions that runtime modules declared, each with the handlers it
   * dispatches to. The compiler bundles one function per entry.
   */
  runtimeFunctions: RuntimeFunction[];
};

export type ResourceCollection = {
  graph: ResourceGraph;
  // Set once evaluation has ended. Contributions to a resource made in this
  // collection are rejected from then on.
  closed: boolean;
  endOfEvaluation: Array<() => unknown | Promise<unknown>>;
  runtime: RuntimeRegistry;
  // Checks of config by async validators, started when resources were
  // declared. Collection fails with the first that fails.
  pendingValidations: Promise<void>[];
  declarationChecks: boolean;
  runtimeReads?: CollectOptions["runtimeReads"];
  // Set while linking makes a call that infra made on a stand-in. Resources
  // declared during the call take this call site in place of their own, which
  // would point at the linking code.
  declarationSite?: () => string | undefined;
  // The app and stage that resource packages put in physical names. Unset
  // when the graph is collected without a deployment, as `notation viz` does.
  scope?: NameScope;
};

export type CollectOptions = {
  scope?: NameScope;
  /**
   * Whether resources check their config when declared. Defaults to true.
   * Code that does not use config, such as destroy, turns the checks off so
   * that config which fails them does not block it.
   */
  declarationChecks?: boolean;
  /**
   * The output keys that each function's bundle reads from infra, such as
   * `infra/orders#orderQueue.url`. When it is set, linking delivers their
   * values to each function, and fails on a read that has no value to
   * deliver. Leave it out to collect the graph before the functions are
   * bundled.
   */
  runtimeReads?: (fn: RuntimeFunction) => string[] | undefined;
};

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
    graph: { resourceGroups: [], resources: [], runtimeFunctions: [] },
    closed: false,
    endOfEvaluation: [],
    runtime: { handlers: [], functions: [], linked: false },
    pendingValidations: [],
    declarationChecks: opts.declarationChecks ?? true,
    runtimeReads: opts.runtimeReads,
    scope: opts.scope,
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
