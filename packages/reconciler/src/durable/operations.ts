import type { BaseResource, ResourceType } from "@notation/resource";
import { RevConflict, type StateNode } from "@notation/state";
import {
  createMissingResourceRegistryMatchWarningEvent,
  createResourceRegistryFromResources,
  resolveResourceClass,
} from "../resource-registry";
import {
  createResourceOperation,
  deleteResourceOperation,
  readDriftOperation,
  updateResourceOperation,
  type PersistState,
  type RemoveState,
  type ResourceOperationBaseParams,
} from "../operations";
import { decideAction, type ResourceAction } from "../plan";
import type { DurableStateBackend } from "./state-backend";
import { durableEmitter, scopeStep, type DurableStepRunner } from "./step";
import {
  resourceStateStore,
  toStateNode,
  type ResourceSnapshot,
} from "./stores";
import type { DurableDeployOptions, DurableOperationOptions } from "./types";
import type { DurableStep } from "./yieldstar";

export async function* reconcileResource(
  step: DurableStep,
  resource: BaseResource,
  opts: DurableDeployOptions,
): AsyncGenerator<any, void, any> {
  const scope = scopeStep(step, `notation:resource:${resource.id}`);
  const emit = durableEmitter(scope, opts.emit);

  const { stateNode, snapshot } = yield* hydrateResource(scope, resource, opts);

  // Decide the operation from desired params vs persisted state. The params
  // are resolved once and then carried: deriveParams is user code and need
  // not be deterministic, so an operation resolving them again could persist
  // params other than the ones the decision was taken against.
  const params = yield* scope.run("params", () => resource.getParams());
  const shared = {
    ...operationParams(scope, resource, opts),
    resourceParams: params,
    persistedOutput: stateNode?.output,
  };
  let action: ResourceAction = decideAction({ resource, stateNode, params });

  // A noop is only trusted after the remote is read back: the provider may
  // have drifted from persisted state, which upgrades the decision.
  if (action.decision === "noop" && (opts.driftDetection ?? true)) {
    // Its own scope: the operation that follows reads the remote again, and
    // the two reads must not share step keys.
    const driftScope = scope.scope("drift-read");
    const driftRead = yield* readDriftOperation(driftScope, {
      ...operationParams(driftScope, resource, opts),
      // A dry run suppresses mutations, not reads. Threading dryRun in here
      // would make the read return {} without touching the provider, which
      // decideAction would then diff against the desired params and report as
      // drift that is not there.
      dryRun: undefined,
      resourceParams: params,
      persistedOutput: stateNode?.output,
    });
    action = decideAction({ resource, stateNode, params, driftRead });
  }

  if (action.decision === "drift-update") {
    yield* emit({
      level: "info",
      event: "reconciler.drift.detected",
      resourceId: resource.id,
      resourceType: resource.type,
      diff: action.patch,
    });
  }

  yield* emit({
    level: "info",
    event: "reconciler.deploy.decision",
    resourceId: resource.id,
    resourceType: resource.type,
    decision: action.decision,
  });

  if (action.decision === "noop") return;

  const persist = persistResourceState(scope, opts, resource, snapshot);
  if (action.decision === "create" || action.decision === "drift-recreate") {
    yield* createResourceOperation(scope, { ...shared, persist });
    return;
  }

  yield* updateResourceOperation(scope, {
    ...shared,
    patch: action.patch,
    persist,
  });
}

export async function* deleteResource(
  step: DurableStepRunner,
  resource: BaseResource,
  opts: DurableOperationOptions,
): AsyncGenerator<any, void, any> {
  // Hydrate output from persisted state; the delete call needs the primary
  // key and the state removal must be conditional on this exact snapshot.
  const snapshot = yield* readSnapshot(step, opts.state, resource.id);
  if (!snapshot) return;
  const stateNode = toStateNode(snapshot);
  resource.setOutput(stateNode.output);

  yield* deleteResourceOperation(step, {
    ...operationParams(step, resource, opts),
    remove: removeResourceState(step, opts, resource, snapshot),
  });
}

/**
 * Deletes persisted resources that are no longer in the desired set. A state
 * node whose type has no registry entry is left in place and surfaced as a
 * warning, because deleting it would need a resource class we cannot resolve.
 */
export async function* sweepOrphans(
  step: DurableStepRunner,
  opts: DurableOperationOptions,
  workflow: "deploy" | "destroy",
): AsyncGenerator<any, void, any> {
  const resourceById = new Map(
    opts.resources.map((resource) => [resource.id, resource]),
  );
  const persisted = yield* step.run("list", () => opts.state.values());
  const registry =
    opts.registry ?? createResourceRegistryFromResources(opts.resources);

  for (const node of persisted) {
    if (resourceById.has(node.id)) continue;
    const nodeScope = step.scope(node.id);

    const Resource = resolveResourceClass(registry, node.type as ResourceType);
    if (!Resource) {
      const emit = durableEmitter(nodeScope, opts.emit);
      yield* emit(
        createMissingResourceRegistryMatchWarningEvent({
          workflow,
          resourceId: node.id,
          resourceType: node.type as ResourceType,
        }),
      );
      continue;
    }

    const resource = new Resource({ id: node.id, config: node.config });
    resource.setOutput(node.output);
    yield* deleteResource(nodeScope, resource, opts);
  }
}

/**
 * Reads the persisted record once. The snapshot is kept so that later writes
 * can be made conditional on the exact instance identity and version read
 * here, and is re-served to the operations so they need no second read.
 */
async function* hydrateResource(
  step: DurableStepRunner,
  resource: BaseResource,
  opts: DurableOperationOptions,
): AsyncGenerator<
  any,
  { stateNode?: StateNode; snapshot?: ResourceSnapshot },
  any
> {
  const snapshot = yield* readSnapshot(step, opts.state, resource.id);
  if (!snapshot) return {};

  const stateNode = toStateNode(snapshot);
  resource.setOutput(stateNode.output);
  return { stateNode, snapshot };
}

function readSnapshot(
  step: DurableStepRunner,
  state: DurableStateBackend,
  resourceId: string,
): AsyncGenerator<any, ResourceSnapshot | undefined, any> {
  return step.run("state:snapshot", () => state.snapshot(resourceId));
}

/** The half of the operation params every durable driver call site shares. */
function operationParams(
  step: DurableStepRunner,
  resource: BaseResource,
  opts: DurableOperationOptions,
): ResourceOperationBaseParams {
  return {
    resource,
    dryRun: opts.dryRun,
    emit: durableEmitter(step, opts.emit),
    maxOperationAttempts: opts.maxOperationAttempts,
  };
}

/**
 * State writes go through the workflow store, never through the state backend:
 * the store stamps the write with the step that made it, so the applied-step
 * ledger and the state change commit together. Replaying then returns the
 * recorded result instead of retrying a compare-and-set that would now fail.
 */
function persistResourceState(
  step: DurableStepRunner,
  opts: DurableOperationOptions,
  resource: BaseResource,
  snapshot: ResourceSnapshot | undefined,
): PersistState {
  return async function* (next) {
    if (!snapshot) {
      // Create-if-absent. A racing writer would win here and this record would
      // be silently adopted rather than written, which is safe only because a
      // deployment is held exclusively for the length of the workflow.
      yield* step.store(resourceStateStore, {
        id: opts.state.storeId(resource.id),
        initial: next,
      });
      return;
    }

    const store = yield* step.store(resourceStateStore, {
      id: opts.state.storeId(resource.id),
    });
    const result = yield* store.updateFrom(
      `state:persist:${resource.id}`,
      snapshot,
      () => next,
    );
    if (!result.updated) {
      throw new RevConflict(
        resource.id,
        snapshot.version + 1,
        result.actualVersion + 1,
      );
    }
  };
}

function removeResourceState(
  step: DurableStepRunner,
  opts: DurableOperationOptions,
  resource: BaseResource,
  snapshot: ResourceSnapshot,
): RemoveState {
  return async function* () {
    const store = yield* step.store(resourceStateStore, {
      id: opts.state.storeId(resource.id),
    });
    const result = yield* store.deleteFrom(
      `state:delete:${resource.id}`,
      snapshot,
    );
    if (!result.deleted) {
      throw new RevConflict(resource.id, snapshot.version + 1, undefined);
    }
  };
}
