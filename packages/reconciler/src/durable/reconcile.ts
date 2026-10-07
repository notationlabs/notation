/**
 * Per-resource reconciliation: converging, deleting, and sweeping single
 * resources, each built on one read of the resource's persisted record and
 * writes conditional on that read.
 */
import type { BaseResource, ResourceType } from "@notation/resource";
import { VersionConflict, type StateNode } from "@notation/state";
import {
  createResourceRegistryFromResources,
  resolveResourceClass,
} from "../resource-registry";
import {
  applyDriftDetection,
  createResourceOperation,
  deleteResourceOperation,
  updateResourceOperation,
  type CreateResourceParams,
  type PersistState,
  type RemoveState,
} from "../operations";
import { decideAction } from "../plan";
import { durableEmitter, scopeStep, type DurableStepRunner } from "./step";
import {
  resourceStateStore,
  toStateNode,
  type ResourceSnapshot,
} from "./stores";
import type { DurableDeployOptions, DurableWorkflowOptions } from "./types";
import type { DurableStep } from "./yieldstar";

/**
 * A read of a resource's persisted record, together with the writes that are
 * conditional on that exact read. `remove` exists only alongside a `node`:
 * a record that was never read cannot be removed safely.
 */
type ResourceStateSession =
  | { node: undefined; persist: PersistState; remove?: never }
  | { node: StateNode; persist: PersistState; remove: RemoveState };

/**
 * Reconciles one resource: load the persisted record, decide, read the
 * remote when the decision needs it, announce the decision, then act. `step`
 * must already be scoped to the resource.
 */
export async function* reconcileResource(
  step: DurableStepRunner,
  resource: BaseResource,
  opts: DurableDeployOptions,
): AsyncGenerator<any, void, any> {
  // Resolved once and then carried: deriveParams is user code and need not be
  // deterministic, so an operation resolving them again could persist params
  // other than the ones the decision was taken against. The step also pins
  // the answer across a replay.
  const params = yield* step.run("params", () => resource.getParams());

  const emit = durableEmitter(step, opts.emit);
  const session = yield* openStateSession(step, opts, resource);
  if (session.node) resource.setOutput(session.node.output);

  let action = decideAction({ resource, stateNode: session.node, params });

  // Its own scope: when the gate fires, the operation that follows the drift
  // read reads the remote again, and the two reads must not share step keys.
  const driftStep = step.scope("drift-read");
  action = yield* applyDriftDetection(driftStep, {
    action,
    driftDetection: opts.driftDetection,
    resource,
    resourceParams: params,
    persistedOutput: session.node?.output,
    // No dryRun: a dry run suppresses mutations, not reads, and reading is
    // how a dry run reports drift at all.
    emit: durableEmitter(driftStep, opts.emit),
    maxOperationAttempts: opts.maxOperationAttempts,
  });

  if (
    action.decision === "drift-update" ||
    action.decision === "drift-replace"
  ) {
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
    ...("replaceFields" in action
      ? { replaceFields: action.replaceFields }
      : {}),
  });

  const shared = {
    resource,
    resourceParams: params,
    persistedOutput: session.node?.output,
    dryRun: opts.dryRun,
    emit,
    maxOperationAttempts: opts.maxOperationAttempts,
  };

  switch (action.decision) {
    case "create":
    case "drift-recreate":
      yield* createResourceOperation(step, {
        ...shared,
        persist: session.persist,
      });
      return;
    case "update":
    case "drift-update":
      yield* updateResourceOperation(step, {
        ...shared,
        patch: action.patch,
        persist: session.persist,
      });
      return;
    case "replace":
    case "drift-replace":
      if (!session.node) {
        throw new Error(
          `Cannot replace ${resource.id}: it has no state record`,
        );
      }
      yield* replaceResource(step, opts, session, shared);
      return;
    case "noop":
      return;
  }
}

/**
 * Deletes the resource and then creates it again, each half in its own scope.
 * Deleting first is deliberate: a resource usually takes its physical name
 * from its params, so a new one created beside the old would collide with it.
 * The new record is a new store instance, so observers can tell the
 * replacement from the resource it replaced.
 */
async function* replaceResource(
  step: DurableStepRunner,
  opts: DurableDeployOptions,
  session: Extract<ResourceStateSession, { node: StateNode }>,
  shared: Omit<CreateResourceParams, "persist">,
): AsyncGenerator<any, void, any> {
  const deleteStep = step.scope("replace:delete");
  yield* deleteResourceOperation(deleteStep, {
    resource: shared.resource,
    dryRun: shared.dryRun,
    emit: durableEmitter(deleteStep, opts.emit),
    maxOperationAttempts: shared.maxOperationAttempts,
    remove: session.remove,
  });

  const createStep = step.scope("replace:create");
  yield* createResourceOperation(createStep, {
    ...shared,
    emit: durableEmitter(createStep, opts.emit),
    // The persisted output describes the resource that was just deleted.
    persistedOutput: undefined,
    persist: createResourceState(createStep, opts, shared.resource),
  });
}

/**
 * Deletes one resource. A resource with no persisted record was never created
 * — or has already been deleted — and is skipped, which is also what makes
 * the sweep of a partly-deleted deployment idempotent. `step` must already be
 * scoped to the resource.
 */
export async function* deleteResource(
  step: DurableStepRunner,
  resource: BaseResource,
  opts: DurableWorkflowOptions,
): AsyncGenerator<any, void, any> {
  const session = yield* openStateSession(step, opts, resource);
  if (!session.node) return;
  resource.setOutput(session.node.output);

  yield* deleteResourceOperation(step, {
    resource,
    dryRun: opts.dryRun,
    emit: durableEmitter(step, opts.emit),
    maxOperationAttempts: opts.maxOperationAttempts,
    remove: session.remove,
  });
}

/**
 * Deletes persisted resources that are no longer in the desired set. A state
 * node whose type has no registry entry is left in place and surfaced as a
 * warning, because deleting it would need a resource class we cannot resolve.
 */
export async function* sweepOrphans(
  step: DurableStep,
  opts: DurableWorkflowOptions,
  workflow: "deploy" | "destroy",
): AsyncGenerator<any, void, any> {
  const scope = scopeStep(step, "notation:orphans");
  const resourceById = new Map(
    opts.resources.map((resource) => [resource.id, resource]),
  );
  const persisted = yield* scope.run("list", () => opts.state.values());
  const registry =
    opts.registry ?? createResourceRegistryFromResources(opts.resources);

  for (const node of persisted) {
    if (resourceById.has(node.id)) continue;
    const nodeScope = scope.scope(encodeURIComponent(node.id));

    const Resource = resolveResourceClass(registry, node.type as ResourceType);
    if (!Resource) {
      const emit = durableEmitter(nodeScope, opts.emit);
      yield* emit({
        level: "warn",
        event: "reconciler.orphan-deletion.skipped",
        reason: "resource-type-not-registered",
        workflow,
        resourceId: node.id,
        resourceType: node.type as ResourceType,
      });
      continue;
    }

    const resource = new Resource({ id: node.id, config: node.config });
    resource.setOutput(node.output);
    yield* deleteResource(nodeScope, resource, opts);
  }
}

/**
 * Reads the persisted record once and binds the writes conditional on it.
 *
 * The snapshot is the precondition: it names the exact store instance and
 * version the record was read at, so a write made against it cannot land on a
 * record another writer has moved on.
 */
async function* openStateSession(
  step: DurableStepRunner,
  opts: DurableWorkflowOptions,
  resource: BaseResource,
): AsyncGenerator<any, ResourceStateSession, any> {
  const snapshot = yield* step.run("persisted-record", () =>
    opts.state.snapshot(resource.id),
  );
  const persist = persistResourceState(step, opts, resource, snapshot);
  if (!snapshot) return { node: undefined, persist };

  return {
    node: toStateNode(snapshot),
    persist,
    remove: removeResourceState(step, opts, resource, snapshot),
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
  opts: DurableWorkflowOptions,
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
      throw new VersionConflict(
        resource.id,
        snapshot.version,
        result.actualVersion,
      );
    }
  };
}

/**
 * Create-if-absent for a record removed earlier in the same execution. It
 * cannot go through a workflow store: opening a store is a step keyed by the
 * store's ID alone, and the removal already opened this one. Creating a store
 * is exactly what that step does, so running it as a keyed step here is no
 * weaker, and like any create-if-absent it is safe to repeat.
 */
function createResourceState(
  step: DurableStepRunner,
  opts: DurableWorkflowOptions,
  resource: BaseResource,
): PersistState {
  return async function* (next) {
    yield* step.run("state:create", () =>
      opts.state.createIfAbsent(resource.id, next),
    );
  };
}

function removeResourceState(
  step: DurableStepRunner,
  opts: DurableWorkflowOptions,
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
      // "conflict" carries the version the record moved to; "not-found" means
      // the record is genuinely gone, which the message reports as "missing".
      throw new VersionConflict(
        resource.id,
        snapshot.version,
        result.reason === "conflict" ? result.actualVersion : undefined,
      );
    }
  };
}
