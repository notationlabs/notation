import type { BaseResource, ResourceType } from "@notation/resource";
import { RevConflict } from "@notation/state";
import {
  createMissingResourceRegistryMatchWarningEvent,
  createResourceRegistryFromResources,
  resolveResourceClass,
} from "../resource-registry";
import type { PersistState, RemoveState, StepRunner } from "../operations";
import {
  destroyResource,
  reconcileResource as reconcile,
  type EmitFromStep,
  type OpenStateSession,
} from "../reconcile";
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

  // Resolved once and then carried: deriveParams is user code and need not be
  // deterministic, so an operation resolving them again could persist params
  // other than the ones the decision was taken against. The step also pins
  // the answer across a replay.
  const params = yield* scope.run("params", () => resource.getParams());

  yield* reconcile(scope, {
    resource,
    resourceParams: params,
    openSession: durableSession(scope, opts),
    emit: durableEmit(opts),
    dryRun: opts.dryRun,
    driftDetection: opts.driftDetection,
    maxOperationAttempts: opts.maxOperationAttempts,
  });
}

export async function* deleteResource(
  step: DurableStepRunner,
  resource: BaseResource,
  opts: DurableOperationOptions,
): AsyncGenerator<any, void, any> {
  // No recovery pass: a workflow's conditional writes are stamped with the
  // step that made them, so a replay is served the recorded result rather
  // than losing a race with itself.
  yield* destroyResource(step, {
    resource,
    openSession: durableSession(step, opts),
    emit: durableEmit(opts),
    dryRun: opts.dryRun,
    maxOperationAttempts: opts.maxOperationAttempts,
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

/** Delivery is checkpointed per scope, so the scope decides the key. */
function durableEmit(opts: DurableOperationOptions): EmitFromStep {
  return (step: StepRunner) => durableEmitter(step, opts.emit);
}

/**
 * Reads the persisted record once and binds the writes conditional on it.
 *
 * The snapshot is the precondition: it names the exact store instance and
 * version the record was read at, so a write made against it cannot land on a
 * record another writer has moved on. It is re-served to the operations so
 * they need no second read.
 */
function durableSession(
  step: DurableStepRunner,
  opts: DurableOperationOptions,
): OpenStateSession {
  return async function* (resource: BaseResource) {
    const snapshot = yield* step.run("state:snapshot", () =>
      opts.state.snapshot(resource.id),
    );
    const persist = persistResourceState(step, opts, resource, snapshot);
    if (!snapshot) return { node: undefined, persist };

    return {
      node: toStateNode(snapshot),
      persist,
      remove: removeResourceState(step, opts, resource, snapshot),
    };
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
