import type { BaseResource } from "@notation/resource";
import type { RevConflict, StateNode } from "@notation/state";
import type { EmitStep, ReconcilerEvent } from "./events";
import {
  createResourceOperation,
  deleteResourceOperation,
  readDriftOperation,
  updateResourceOperation,
  type PersistState,
  type RemoveState,
  type StepRunner,
} from "./operations";
import { decideAction } from "./plan";

/**
 * A read of a resource's persisted record, together with the writes that are
 * conditional on that exact read.
 *
 * The union is the point: `remove` exists only alongside a `node`, because
 * removing a record that was never read is not a thing either driver can do
 * safely. Keeping the writes bound to the read that produced them is what
 * stops a node being combined with a precondition from a different read — a
 * revision in process, a store snapshot in a workflow.
 */
export type ResourceStateSession =
  | { node: undefined; persist: PersistState; remove?: never }
  | { node: StateNode; persist: PersistState; remove: RemoveState };

/**
 * Opens a session. A factory rather than an open session because recovery
 * re-reads: the first pass opens once, and a recovering pass opens again
 * against whatever the winning writer left behind.
 */
export type OpenStateSession = (
  resource: BaseResource,
) => AsyncGenerator<unknown, ResourceStateSession, unknown>;

/**
 * How a driver delivers an event from a given scope. Emission is scoped
 * because a workflow checkpoints it, and two reads of the same resource in
 * one execution must not share a checkpoint key.
 */
export type EmitFromStep = (step: StepRunner) => EmitStep<ReconcilerEvent>;

export type ReconcileResourceOptions = {
  resource: BaseResource;
  /** Resolved once per scheduled reconciliation, recovery included. */
  resourceParams: Record<string, unknown>;
  openSession: OpenStateSession;
  emit?: EmitFromStep;
  dryRun?: boolean;
  driftDetection?: boolean;
  maxOperationAttempts?: number;
  /**
   * Set when a previous attempt lost a conditional write. The remote is then
   * read unconditionally and the decision retaken against it, so the attempt
   * adopts what the winning writer did rather than repeating its own work.
   */
  recoverFrom?: RevConflict;
};

/**
 * Reconciles one resource: hydrate, decide, read the remote when the decision
 * needs it, announce the decision, then act.
 *
 * Both drivers run this same generator. What stays outside it is scheduling
 * (dependency levels, concurrency), the conflict retry policy, opening state
 * sessions, and how a step is run — in process a plain await under a mutation
 * lease, in a workflow a checkpointed step under a deployment hold.
 */
export async function* reconcileResource(
  step: StepRunner,
  opts: ReconcileResourceOptions,
): AsyncGenerator<unknown, void, unknown> {
  const { resource, resourceParams: params } = opts;
  const recovering = opts.recoverFrom !== undefined;

  // Recovery is built on re-reading the remote, so a resource that cannot be
  // read cannot be recovered: the conflict is the caller's answer.
  if (recovering && !resource.read) throw opts.recoverFrom;

  const emit = opts.emit?.(step);
  const session = yield* opts.openSession(resource);
  if (session.node) resource.setOutput(session.node.output);

  let action = decideAction({ resource, stateNode: session.node, params });

  // A noop is only trusted once the remote has been read back: the provider
  // may have drifted from persisted state, which upgrades the decision.
  // Recovery always reads, because the point of it is to see what the writer
  // that won the race actually left behind.
  if (
    recovering ||
    (action.decision === "noop" && (opts.driftDetection ?? true))
  ) {
    // Its own scope: the operation that follows reads the remote again, and
    // the two reads must not share step keys.
    const driftStep = step.scope("drift-read");
    const driftRead = yield* readDriftOperation(driftStep, {
      resource,
      resourceParams: params,
      persistedOutput: session.node?.output,
      // Deliberately no dryRun: a dry run suppresses mutations, not reads.
      // Reading is how a dry run reports drift at all.
      emit: opts.emit?.(driftStep),
      maxOperationAttempts: opts.maxOperationAttempts,
    });
    action = decideAction({
      resource,
      stateNode: session.node,
      params,
      driftRead,
    });
    if (recovering && driftRead.kind === "present") {
      resource.setOutput(driftRead.output);
    }
  }

  if (action.decision === "drift-update") {
    yield* emitEvent(emit, {
      level: "info",
      event: "reconciler.drift.detected",
      resourceId: resource.id,
      resourceType: resource.type,
      diff: action.patch,
    });
  }

  yield* emitEvent(emit, {
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
      // A first-pass noop writes nothing. A recovering noop has to: it read
      // the remote, found it already converged, and owes a record of that
      // adoption at the revision it re-read, or the next deployment would
      // reconcile against the losing writer's view.
      if (!recovering || opts.dryRun) return;
      yield* session.persist({
        id: resource.id,
        groupId: resource.groupId,
        groupType: resource.groupType,
        type: resource.type,
        lastOperation: "drift",
        lastOperationAt: new Date().toISOString(),
        config: resource.config,
        params: resource.toState(params),
        output: resource.toState(resource.output),
      });
  }
}

export type DestroyResourceOptions = {
  resource: BaseResource;
  openSession: OpenStateSession;
  emit?: EmitFromStep;
  dryRun?: boolean;
  maxOperationAttempts?: number;
  /**
   * Set when a previous attempt lost its conditional removal. Carries the
   * params because the recovery read needs them, and deletion is the one path
   * that never resolves them otherwise.
   */
  recoverFrom?: {
    conflict: RevConflict;
    resourceParams: Record<string, unknown>;
  };
};

/**
 * Deletes one resource. A resource with no persisted record was never created
 * — or has already been deleted — and is skipped, which is also what makes
 * the sweep of a partly-deleted deployment idempotent.
 */
export async function* destroyResource(
  step: StepRunner,
  opts: DestroyResourceOptions,
): AsyncGenerator<unknown, void, unknown> {
  const { resource } = opts;
  const session = yield* opts.openSession(resource);
  if (!session.node) return;
  resource.setOutput(session.node.output);

  if (opts.recoverFrom) {
    const { conflict, resourceParams } = opts.recoverFrom;
    if (!resource.read) throw conflict;

    const driftStep = step.scope("drift-read");
    const remote = yield* readDriftOperation(driftStep, {
      resource,
      resourceParams,
      persistedOutput: session.node.output,
      emit: opts.emit?.(driftStep),
      maxOperationAttempts: opts.maxOperationAttempts,
    });

    // Already gone remotely: the delete succeeded and only the record is
    // left, so drop the record rather than calling the provider again.
    if (remote.kind !== "present") {
      if (!opts.dryRun) yield* session.remove();
      return;
    }
    resource.setOutput(remote.output);
  }

  yield* deleteResourceOperation(step, {
    resource,
    dryRun: opts.dryRun,
    emit: opts.emit?.(step),
    maxOperationAttempts: opts.maxOperationAttempts,
    remove: session.remove,
  });
}

function emitEvent(
  emit: EmitStep<ReconcilerEvent> | undefined,
  event: ReconcilerEvent,
): AsyncGenerator<unknown, void, unknown> {
  return emit ? emit(event) : noSteps();
}

async function* noSteps(): AsyncGenerator<unknown, void, unknown> {}
