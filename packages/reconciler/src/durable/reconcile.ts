/**
 * Per-resource reconciliation: converging, deleting, and sweeping single
 * resources, each built on one read of the resource's persisted record and
 * writes conditional on that read.
 */
import type { BaseResource, ResourceType } from "@notation/resource";
import { RevConflict, type StateNode } from "@notation/state";
import {
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
} from "../operations";
import { decideAction, decideDriftAction } from "../plan";
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

  // A noop is only trusted once the remote has been read back: the provider
  // may have drifted from persisted state, which upgrades the decision. A
  // resource with no read has no remote to compare, so its noop stands.
  if (
    action.decision === "noop" &&
    (opts.driftDetection ?? true) &&
    resource.read
  ) {
    // Its own scope: the operation that follows reads the remote again, and
    // the two reads must not share step keys.
    const driftStep = step.scope("drift-read");
    const driftRead = yield* readDriftOperation(driftStep, {
      resource,
      resourceParams: params,
      persistedOutput: session.node?.output,
      // No dryRun: a dry run suppresses mutations, not reads, and reading is
      // how a dry run reports drift at all.
      emit: durableEmitter(driftStep, opts.emit),
      maxOperationAttempts: opts.maxOperationAttempts,
    });
    action = decideDriftAction({ resource, params, driftRead });
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
    case "noop":
      return;
  }
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
      throw new RevConflict(resource.id, snapshot.version + 1, undefined);
    }
  };
}
