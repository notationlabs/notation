/**
 * Per-resource reconciliation: converging, deleting, and sweeping single
 * resources, each built on one read of the resource's persisted record and
 * writes conditional on that read.
 */
import {
  SchemaStructureError,
  assertRequiredOutputs,
  collectResourceGraph,
  fillPhysicalNames,
  validateParams,
  type BaseResource,
  type DurableObject,
  type ResourceClass,
  type ResourceGroupRef,
  type ResourceDeletion,
  type ResourceType,
} from "@notation/resource";
import {
  VersionConflict,
  isCreatingRecord,
  type RetiredInstance,
  type StateNode,
} from "@notation/state";
import { remainingDependencies } from "../cycles";
import { collectDependents } from "../dependency-graph";
import { createBlocksDelete } from "../delete-cascade";
import type { EmitStep, OperationLifecycleEvent } from "../events";
import { sweepSteps, sweptRecords } from "../orphan-sweep";
import { resolveResourceClass, workflowRegistry } from "../resource-registry";
import { assertSameType } from "../resource-type";
import {
  applyDriftDetection,
  createResourceOperation,
  deleteResourceOperation,
  emitLifecycleEvent,
  readResourceOperation,
  toPersistedState,
  updateResourceOperation,
  type CreateResourceParams,
  type PersistedResourceState,
  type PersistStage,
  type PersistState,
  type RemoveState,
} from "../operations";
import {
  assertChangeAllowed,
  assertOrphanDeleteAllowed,
  decideAction,
  decideDriftAction,
  getDependencyIds,
  hasSameEdges,
  recordedEdges,
  retiredEdges,
  type DriftRead,
  type ResourceAction,
} from "../plan";
import { assertOutputsRecoverable } from "../planner";
import {
  assertNamesNotSupplied,
  generateNames,
  recordedNames,
  nameFields,
  replaceOrder,
  unknownNames,
} from "../physical-names";
import { durableEmitter, scopeStep, type DurableStepRunner } from "./step";
import {
  resourceStateStore,
  toStateNode,
  type ResourceSnapshot,
} from "./stores";
import type { DeployContext, DurableWorkflowOptions } from "./types";
import {
  InfrastructureError,
  WorkflowCancelledError,
  type DurableStep,
} from "./sdk";

/**
 * A read of a resource's persisted record, together with the writes that are
 * conditional on that exact read. `remove` exists only alongside a `node`:
 * a record that was never read cannot be removed safely.
 */
export type ResourceStateSession =
  | { node: undefined; persist: PersistState; remove?: never }
  | { node: StateNode; persist: PersistState; remove: RemoveState };

type SnapshotRef = { current: ResourceSnapshot };

type SharedParams = Omit<CreateResourceParams, "persist"> & {
  /**
   * The params before the names are filled in, so that a replacement can
   * fill in its new names, also where a param refers to one.
   */
  unnamedParams: Record<string, unknown>;
};

export type ReconcileOptions = {
  /** Leaves out the decision event when the decision is noop. */
  quietNoop?: boolean;
  /** Called with the decision before deploy acts on it. Throws to stop. */
  onDecision?: (decision: ResourceAction["decision"]) => void;
  /**
   * Leaves out the contributions that depend on one of these, to create or
   * update the placeholder of a cycle. The decision event is marked as a
   * placeholder.
   */
  excludeContributionsFrom?: ReadonlySet<BaseResource>;
  /**
   * Called when deploy replaces the resource delete-first, after the delete,
   * with the IDs of the dependents that the replacement deleted because they
   * block the delete. Deploy creates the resource without the contributions
   * that depend on one of the returned resources. A create-first replace
   * deletes nothing, and does not call it.
   */
  replaceWithout?: (deleted: ReadonlySet<string>) => ReadonlySet<BaseResource>;
  /**
   * The caller's read of the remote. Deploy decides drift from it, and does
   * not read the resource again. A resource that the read found gone is
   * created again, whatever its params.
   */
  driftRead?: DriftRead;
};

/**
 * Reconciles one resource: load the persisted record, decide, read the
 * remote when the decision needs it, announce the decision, then act. `step`
 * must already be scoped to the resource.
 */
export async function* reconcileResource(
  step: DurableStepRunner,
  resource: BaseResource,
  opts: DeployContext,
  options: ReconcileOptions = {},
): AsyncGenerator<any, void, any> {
  const emit = durableEmitter(step, opts.emit);
  const session = yield* openStateSession(step, opts, resource);
  // Repeats the notation:validate check, because validate ran before the
  // hold and the record may have changed since.
  assertSameType(resource, session.node);
  const creating = isCreatingRecord(session.node);
  const recordedOutput = creating ? undefined : session.node?.output;
  if (recordedOutput) resource.setOutput(recordedOutput);

  // Resolved once and then carried: deriveParams is user code and need not be
  // deterministic, so an operation resolving them again could persist params
  // other than the ones the decision was taken against. The step also pins
  // the answer across a replay.
  const configParams = yield* step.run("params", () =>
    resource.getParams({
      excludeContributionsFrom: options.excludeContributionsFrom,
      recordedOutputs: opts.recordedOutputs,
    }),
  );
  const names = nameFields(resource);
  assertNamesNotSupplied(resource, names, configParams);
  // A name in the record wins over a new one, so that a resource that
  // exists, or that an earlier deploy started to create, is not renamed.
  const recorded = recordedNames(names, session.node);
  const params = fillPhysicalNames(configParams, {
    ...recorded,
    ...(yield* generateNamesStep(
      step,
      opts,
      resource,
      names.filter(({ field }) => !(field in recorded)),
      configParams,
    )),
  });
  await validateParams(resource, params, "deploy");
  // A placeholder's record leaves out the edges to the peers that its params
  // leave out, as those may not exist yet.
  const dependsOn = getDependencyIds(
    resource,
    options.excludeContributionsFrom
      ? remainingDependencies(resource, options.excludeContributionsFrom)
      : undefined,
  );

  let action = decideAction({ resource, stateNode: session.node, params });

  // Its own scope: when the gate fires, the operation that follows the drift
  // read reads the remote again, and the two reads must not share step keys.
  const driftStep = step.scope("drift-read");
  const { driftRead } = options;
  if (driftRead?.kind === "absent") {
    action = { decision: "drift-recreate" };
  } else if (driftRead) {
    if (action.decision === "noop") {
      action = decideDriftAction({ resource, params, driftRead });
    }
  } else {
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
  }

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

  options.onDecision?.(action.decision);
  if (action.decision !== "noop" || !options.quietNoop) {
    yield* emitDecision(emit, resource, action, {
      placeholder: Boolean(options.excludeContributionsFrom),
    });
  }

  // The check for a resource with no `read` runs here and not in
  // validateKnownParams, because only here is the decision known. See
  // validateKnownParams. It runs before the operation: an update would change
  // the remote resource and still leave the output missing, and a noop would
  // fail in recoverOutputs without the hint.
  if (action.decision === "noop" || action.decision === "update") {
    assertOutputsRecoverable(resource, session.node);
  }

  yield* applyAction(
    step,
    opts,
    session,
    action,
    {
      executionId: opts.executionId,
      resource,
      unnamedParams: configParams,
      resourceParams: params,
      persistedOutput: recordedOutput,
      dependsOn,
      dryRun: opts.dryRun,
      emit,
      maxOperationAttempts: opts.maxOperationAttempts,
      prior: session.node,
    },
    // The params of a placeholder already leave out the contributions that
    // depend on a member of the cycle.
    options.excludeContributionsFrom ? undefined : options.replaceWithout,
  );
}

async function* emitDecision(
  emit: EmitStep,
  resource: BaseResource,
  action: ResourceAction,
  { placeholder = false } = {},
): AsyncGenerator<any, void, any> {
  yield* emit({
    level: "info",
    event: "reconciler.deploy.decision",
    resourceId: resource.id,
    resourceType: resource.type,
    decision: action.decision,
    ...("replaceFields" in action
      ? {
          replaceFields: action.replaceFields,
          replaceOrder: replaceOrder(resource),
        }
      : {}),
    ...(placeholder ? { placeholder: true as const } : {}),
  });
}

/**
 * Carries out a decision against the record that `session` read.
 */
async function* applyAction(
  step: DurableStepRunner,
  opts: DeployContext,
  session: ResourceStateSession,
  action: ResourceAction,
  shared: SharedParams,
  replaceWithout?: ReconcileOptions["replaceWithout"],
): AsyncGenerator<any, void, any> {
  const { resource, dependsOn } = shared;
  switch (action.decision) {
    case "create":
    case "drift-recreate": {
      const { tookOver } = yield* createResourceOperation(step, {
        ...shared,
        persist: session.persist,
      });
      if (tookOver) {
        yield* reconcileTakenOver(step, opts, shared, replaceWithout);
      }
      return;
    }
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
      if (replaceOrder(resource) === "create-first") {
        yield* replaceCreateFirst(step, opts, session, shared);
      } else {
        yield* replaceDeleteFirst(step, opts, session, shared, replaceWithout);
      }
      return;
    case "noop":
      if (!session.node) return;
      if (findMissingOutputs(resource, session.node.output)) {
        yield* recoverOutputs(step, opts, session, shared);
        return;
      }
      if (
        !opts.dryRun &&
        (!hasSameEdges(session.node, dependsOn) ||
          session.node.provider !== resource.provider ||
          !sameGroup(session.node.group, resource.group))
      ) {
        yield* rewriteRecord(session, resource, dependsOn);
      }
      return;
  }
}

/**
 * Generates a name for each of `fields`, in a step, so that a replay of the
 * execution gets the same names.
 */
async function* generateNamesStep(
  step: DurableStepRunner,
  opts: DeployContext,
  resource: BaseResource,
  fields: ReturnType<typeof nameFields>,
  params: Record<string, unknown>,
): AsyncGenerator<any, Record<string, string>, any> {
  if (fields.length === 0) return {};
  return yield* step.run("physical-names", async () =>
    generateNames(resource, fields, opts.nameScope, params),
  );
}

/**
 * Compares a resource that create took over with the desired params, and
 * updates, replaces or keeps it, as for any recorded resource. Its record
 * was just written from a read, so drift detection is skipped. The record
 * is read again, because the session of the create does not hold what the
 * takeover wrote.
 */
async function* reconcileTakenOver(
  parent: DurableStepRunner,
  opts: DeployContext,
  shared: SharedParams,
  replaceWithout?: ReconcileOptions["replaceWithout"],
): AsyncGenerator<any, void, any> {
  // The state key keeps the writes that follow a takeover apart from the
  // writes of the create that took the resource over. It nests, because a
  // replace that follows a takeover can end in another takeover. It must
  // not equal a persist stage, which sits at the same place in the key.
  const step = parent.scope(
    "taken-over",
    [parent.stateKey, "after-takeover"].filter(Boolean).join(":"),
  );
  const { resource, resourceParams } = shared;
  const takenOver = yield* openStateSession(step, opts, resource);
  const action = decideAction({
    resource,
    stateNode: takenOver.node,
    params: resourceParams,
  });
  const emit = durableEmitter(step, opts.emit);
  yield* emitDecision(emit, resource, action);
  yield* applyAction(
    step,
    opts,
    takenOver,
    action,
    {
      ...shared,
      // Names the effects of a create that replaces the resource apart from
      // those of the create that took it over. It is built from the ID of
      // that create, so that it differs at each level of nesting.
      executionId: `${shared.executionId}/taken-over`,
      emit,
      persistedOutput: takenOver.node?.output,
      prior: takenOver.node,
    },
    replaceWithout,
  );
}

function findMissingOutputs(
  resource: BaseResource,
  output: Record<string, unknown>,
): SchemaStructureError | undefined {
  try {
    assertRequiredOutputs(resource, output);
  } catch (error) {
    if (SchemaStructureError.is(error)) return error;
    throw error;
  }
  return undefined;
}

/**
 * Handles a record that lacks a required output. Create and update write the
 * record before they fail on a missing output, so a later deploy can decide
 * noop for it, and its dependents would read the output as undefined. The
 * resource is read again, and the record is written with what the read
 * returns. The deploy fails while an output is still missing. A resource with
 * no `read` fails before it gets here.
 */
async function* recoverOutputs(
  step: DurableStepRunner,
  opts: DeployContext,
  session: Extract<ResourceStateSession, { node: StateNode }>,
  shared: SharedParams,
): AsyncGenerator<any, void, any> {
  const { resource } = shared;
  const readStep = step.scope("output-read");
  const readResult = yield* readResourceOperation(readStep, {
    resource,
    resourceParams: shared.resourceParams,
    persistedOutput: session.node.output,
    // No dryRun, as for the drift read.
    emit: durableEmitter(readStep, opts.emit),
    maxOperationAttempts: shared.maxOperationAttempts,
  });
  resource.setOutput({ ...session.node.output, ...readResult });

  const missing = findMissingOutputs(resource, resource.output);
  if (!opts.dryRun) {
    yield* session.persist({
      ...toPersistedState(session.node, shared.dependsOn),
      group: resource.group,
      output: resource.toState(resource.output),
    });
  }
  if (missing) throw missing;
}

/**
 * Updates `dependsOn`, `provider` and `group` in the record, without calling
 * the resource's update operation.
 */
async function* rewriteRecord(
  session: Extract<ResourceStateSession, { node: StateNode }>,
  resource: BaseResource,
  dependsOn: string[],
): AsyncGenerator<any, void, any> {
  yield* session.persist({
    ...toPersistedState(session.node, dependsOn),
    provider: resource.provider,
    group: resource.group,
  });
}

function sameGroup(recorded: unknown, group: ResourceGroupRef | null): boolean {
  const ref = (recorded ?? null) as ResourceGroupRef | null;
  return ref?.type === group?.type && ref?.id === group?.id;
}

/**
 * `shared` with the params and edges of the resource without the
 * contributions that depend on one of `excluded`.
 */
async function* withoutContributions(
  step: DurableStepRunner,
  opts: DeployContext,
  shared: SharedParams,
  excluded: ReadonlySet<BaseResource>,
  names: Record<string, string>,
): AsyncGenerator<any, SharedParams, any> {
  const { resource } = shared;
  const unnamed = yield* step.run("replace:params", () =>
    resource.getParams({
      excludeContributionsFrom: excluded,
      recordedOutputs: opts.recordedOutputs,
    }),
  );
  const params = fillPhysicalNames(unnamed, names);
  await validateParams(resource, params, "deploy");
  return {
    ...shared,
    unnamedParams: unnamed,
    resourceParams: params,
    dependsOn: getDependencyIds(
      resource,
      remainingDependencies(resource, excluded),
    ),
  };
}

/**
 * Replaces the resource without deleting it first:
 *
 * 1. Generate new physical names for the replacement.
 * 2. Write the "creating" record, which adds the replaced resource to the
 *    record's retired instances in the same write.
 * 3. Create the replacement.
 *
 * No dependent is deleted. The sweep at the end of the deploy deletes the
 * replaced resource.
 *
 * A failed create writes back the record of the replaced resource. A create
 * with an unknown outcome keeps the "creating" record, so the replaced
 * resource stays retired.
 *
 * Contributions that refer to the resource's own outputs take the outputs of
 * the replaced resource. A cycle updates the replacement with its own outputs
 * in the next pass.
 */
async function* replaceCreateFirst(
  step: DurableStepRunner,
  opts: DeployContext,
  session: Extract<ResourceStateSession, { node: StateNode }>,
  shared: SharedParams,
): AsyncGenerator<any, void, any> {
  const createStep = step.scope("replace:create");
  const emit = durableEmitter(createStep, opts.emit);
  const names = yield* generateNamesStep(
    createStep,
    opts,
    shared.resource,
    nameFields(shared.resource),
    shared.unnamedParams,
  );
  const created = {
    ...shared,
    resourceParams: fillPhysicalNames(shared.unnamedParams, names),
  };
  const { tookOver } = yield* createResourceOperation(createStep, {
    ...created,
    emit,
    // The persisted output describes the resource that is replaced.
    persistedOutput: undefined,
    prior: session.node,
    retired: [
      ...(session.node.retired ?? []),
      retiredInstance(
        session.node,
        shared.dependsOn,
        // A step, so that each write of the create, also after a replay,
        // lists the instance with the same time.
        yield* createStep.run("retired-at", async () =>
          new Date().toISOString(),
        ),
      ),
    ],
    persist: session.persist,
  });
  if (opts.dryRun) {
    // Reports the delete that the sweep makes at the end of the deploy.
    yield* emitLifecycleEvent(
      { resource: shared.resource, emit },
      "delete",
      "dry-run",
      { reason: "retired" },
    );
  }
  if (tookOver) yield* reconcileTakenOver(createStep, opts, created);
}

function retiredInstance(
  node: StateNode,
  dependsOn: string[],
  retiredAt: string,
): RetiredInstance {
  return {
    config: node.config,
    params: node.params,
    output: node.output,
    // A record written before edges were recorded takes the edges in code.
    dependsOn: node.dependsOn ?? dependsOn,
    retiredAt,
  };
}

/**
 * Replaces the resource by deleting it first:
 *
 * 1. Delete the dependents that block the delete. Deploy creates them again
 *    when it reaches them.
 * 2. Delete the retired instances that the record lists.
 * 3. Delete the resource.
 * 4. Create the resource again, in a new store instance, so observers can
 *    tell the replacement from the resource it replaced.
 */
async function* replaceDeleteFirst(
  step: DurableStepRunner,
  opts: DeployContext,
  session: Extract<ResourceStateSession, { node: StateNode }>,
  shared: SharedParams,
  replaceWithout?: ReconcileOptions["replaceWithout"],
): AsyncGenerator<any, void, any> {
  const deleted = yield* deleteBlockingDependents(
    step.scope("replace:dependents"),
    opts,
    shared.resource,
  );

  const deleteStep = step.scope("replace:delete");
  // A class lists retired instances only while it has a `physicalName`
  // param. One that has lost it deletes them with the record.
  yield* deleteRetiredInstances(
    deleteStep,
    opts,
    session,
    resolveResourceClass(workflowRegistry(opts), shared.resource.type)!,
    "deploy",
  );
  yield* deleteResourceOperation(deleteStep, {
    resource: shared.resource,
    deletion: yield* readDeletion(deleteStep, opts, shared.resource),
    dryRun: shared.dryRun,
    emit: durableEmitter(deleteStep, opts.emit),
    maxOperationAttempts: shared.maxOperationAttempts,
    remove: session.remove,
  });

  const createStep = step.scope("replace:create");
  const names = yield* generateNamesStep(
    createStep,
    opts,
    shared.resource,
    nameFields(shared.resource),
    shared.unnamedParams,
  );
  const renamed = {
    ...shared,
    resourceParams: fillPhysicalNames(shared.unnamedParams, names),
  };
  const excluded = replaceWithout?.(new Set(deleted));
  const created = excluded?.size
    ? yield* withoutContributions(step, opts, renamed, excluded, names)
    : renamed;
  // The delete removed the store instance that `session` read, so a write
  // against it would conflict. The record is read again for the create.
  const recreated = yield* openStateSession(createStep, opts, shared.resource);
  const { tookOver } = yield* createResourceOperation(createStep, {
    ...created,
    emit: durableEmitter(createStep, opts.emit),
    // The persisted output describes the resource that was just deleted.
    persistedOutput: undefined,
    // The record was removed with the resource it describes.
    prior: undefined,
    // Without the retired instances, which the delete has deleted.
    replaces: { ...session.node, retired: [] },
    persist: recreated.persist,
  });
  // No `replaceWithout`: the params in `created` already leave out the
  // contributions that a replace of the resource must leave out.
  if (tookOver) yield* reconcileTakenOver(createStep, opts, created);
}

/**
 * Deletes the resources that block the delete of `resource`: each depends on
 * it in state, or on another of them, and its type lists the type of what it
 * depends on in `blocksDeleteOf`. A record also depends on what its retired
 * instances depend on, and is deleted with them. They are deleted in reverse
 * order of the edges in state. Each of them that is still declared has no
 * record afterwards, so deploy creates it again when it reaches it, after
 * `resource` has been created again. Each orphan among them is gone before
 * the sweep reaches it. Every other dependent stays in place, including one
 * with no class. Returns the IDs of the deleted dependents.
 *
 * Records are listed when the replacement starts. Deploy has written the
 * edges in code for every resource it has reached by then, and a resource it
 * has not reached still holds the edges of the resource that exists.
 */
async function* deleteBlockingDependents(
  step: DurableStepRunner,
  opts: DeployContext,
  resource: BaseResource,
): AsyncGenerator<any, string[], any> {
  const registry = workflowRegistry(opts);
  // Skips listing state, which copies every record into the journal.
  const blockable = [...registry.values()].some((Class) =>
    Class.blocksDeleteOf.includes(resource.type),
  );
  if (!blockable) return [];

  const records = yield* step.run("list", () => opts.state.values());
  const resourceById = new Map(
    opts.resources.map((desired) => [desired.id, desired]),
  );
  const recordById = new Map(records.map((node) => [node.id, node]));
  const dependents = collectDependents(
    resource.id,
    new Map(
      records.map((node) => [
        node.id,
        [...recordedEdges(node, resourceById), ...retiredEdges(node)],
      ]),
    ),
    createBlocksDelete(records, registry),
  );

  // Checks each one before it deletes any, so that a rejected change fails
  // before the cascade changes anything.
  for (const id of dependents) {
    const record = recordById.get(id)!;
    const declared = resourceById.get(id);
    if (!declared) {
      assertOrphanDeleteAllowed(registry, record);
      continue;
    }
    if (!declared.rejectChange) continue;
    // A step, as deriveParams is user code and need not be deterministic.
    const params = yield* step.run(
      `params:${encodeURIComponent(id)}`,
      async () =>
        // The dependent is created again, with a new name.
        fillPhysicalNames(
          await declared.planParams({ recordedOutputs: opts.recordedOutputs }),
          unknownNames(declared),
        ) as DurableObject,
    );
    assertChangeAllowed(id, declared.rejectChange, record.params, params, {
      replace: true,
    });
  }

  for (const id of dependents) {
    const record = recordById.get(id)!;
    yield* deleteResource(
      // Two replacements in one deploy can each delete the same dependent.
      step.scope(
        encodeURIComponent(id),
        `replace:${encodeURIComponent(resource.id)}`,
      ),
      await instantiateRecord(
        registry.get(record.type as ResourceType)!,
        record,
      ),
      opts,
      "deploy",
      { reason: "dependency-replaced", replacedDependency: resource.id },
    );
  }
  return dependents;
}

/**
 * Deletes one resource. A resource with no persisted record was never created
 * — or has already been deleted — and is skipped, which is also what makes
 * the sweep of a partly-deleted deployment idempotent. The retired instances
 * that the record lists are deleted first. `step` must already be scoped to
 * the resource.
 * If the record's type differs from `declared`'s type, the record's own class
 * deletes it.
 */
export async function* deleteResource(
  step: DurableStepRunner,
  declared: BaseResource,
  opts: DurableWorkflowOptions,
  workflow: "deploy" | "destroy",
  /** Added to the delete's lifecycle events. */
  cause: Pick<OperationLifecycleEvent, "reason" | "replacedDependency"> = {},
): AsyncGenerator<any, void, any> {
  const session = yield* openStateSession(step, opts, declared);
  if (!session.node) return;
  // The classes in code win in the registry, so a record of the declared
  // type resolves to the declared class.
  const Resource = resolveResourceClass(
    workflowRegistry(opts),
    session.node.type as ResourceType,
  );
  if (!Resource) {
    throw new Error(
      `No class is registered for type ${session.node.type}, the type of ` +
        `the state record of ${declared.id}. The orphan sweep keeps such a ` +
        `record, so destroy should not reach it.`,
    );
  }
  const resource =
    session.node.type === declared.type
      ? declared
      : await instantiateRecord(Resource, session.node);
  resource.setOutput(session.node.output);

  yield* deleteRetiredInstances(step, opts, session, Resource, workflow);
  const emit = durableEmitter(step, opts.emit);
  yield* deleteResourceOperation(step, {
    resource,
    deletion: yield* readDeletion(step, opts, resource),
    dryRun: opts.dryRun,
    emit: (event) => emit({ ...event, ...cause }),
    maxOperationAttempts: opts.maxOperationAttempts,
    remove: session.remove,
    creatingParams: isCreatingRecord(session.node)
      ? session.node.params
      : undefined,
  });
}

/**
 * Reads what a `delete` of `resource` is told about the delete, when its
 * type takes it: the resources whose state records depend on it now, and the
 * retired instances that depend on it. Listed just before the delete, so
 * that it leaves out the dependents that deploy has already deleted. The
 * step returns only the dependents, as its result is copied into the
 * journal.
 */
async function* readDeletion(
  step: DurableStepRunner,
  opts: DurableWorkflowOptions,
  resource: BaseResource,
): AsyncGenerator<any, ResourceDeletion | undefined, any> {
  if (!resource.deleteTakesDependents || opts.dryRun) return undefined;
  const resourceById = new Map(
    opts.resources.map((desired) => [desired.id, desired]),
  );
  const dependents = yield* step.run("dependents", async () =>
    (await opts.state.values()).flatMap((node) => {
      if (node.id === resource.id) return [];
      const { id, type } = node;
      return [
        ...(recordedEdges(node, resourceById).includes(resource.id)
          ? [{ id, type, params: node.params }]
          : []),
        ...retiredDependents(node, resource.id),
      ];
    }),
  );
  return { dependents };
}

/** The retired instances that `node` lists and that depend on `id`. */
function retiredDependents(node: StateNode, id: string) {
  return (node.retired ?? [])
    .filter((instance) => instance.dependsOn.includes(id))
    .map((instance) => ({
      id: node.id,
      type: node.type,
      params: instance.params,
    }));
}

/**
 * `readDeletion` for a retired instance. The dependents in code are left
 * out, as they have moved to the replacement. The retired instances of other
 * records that depend on the resource are added. The sweep deletes them
 * first, except when retired instances depend on each other, as the retired
 * members of a cycle do.
 */
async function* readRetiredDeletion(
  step: DurableStepRunner,
  opts: DurableWorkflowOptions,
  resource: BaseResource,
): AsyncGenerator<any, ResourceDeletion | undefined, any> {
  if (!resource.deleteTakesDependents || opts.dryRun) return undefined;
  const inCode = new Set(opts.resources.map((desired) => desired.id));
  const dependents = yield* step.run("dependents", async () =>
    (await opts.state.values()).flatMap((node) => {
      if (node.id === resource.id) return [];
      const { id, type } = node;
      return [
        ...(!inCode.has(id) && (node.dependsOn ?? []).includes(resource.id)
          ? [{ id, type, params: node.params }]
          : []),
        ...retiredDependents(node, resource.id),
      ];
    }),
  );
  return { dependents };
}

/**
 * Deletes the retired instances that the record of `session` lists. For each
 * instance, oldest first:
 *
 * 1. Delete the instance with `Resource`.
 * 2. Remove the instance from the list, with a write against the record that
 *    the previous step left.
 *
 * When the provider refuses a delete, the instance stays retired, and the
 * error names the resources in code that depend on the resource.
 */
async function* deleteRetiredInstances(
  step: DurableStepRunner,
  opts: DurableWorkflowOptions,
  session: Extract<ResourceStateSession, { node: StateNode }>,
  Resource: ResourceClass<any, any, any>,
  workflow: "deploy" | "destroy",
): AsyncGenerator<any, void, any> {
  const { node } = session;
  const instances = node.retired ?? [];
  for (const [index, instance] of instances.entries()) {
    const scoped = step.scope(`retired:${index}`);
    const retired = await instantiateRecord(Resource, { ...node, ...instance });
    const emit = durableEmitter(scoped, opts.emit);
    const deletion = yield* readRetiredDeletion(scoped, opts, retired);
    let writing = false;
    try {
      yield* deleteResourceOperation(scoped, {
        resource: retired,
        deletion,
        dryRun: opts.dryRun,
        emit: (event) => emit({ ...event, reason: "retired" }),
        maxOperationAttempts: opts.maxOperationAttempts,
        remove: () => {
          writing = true;
          return session.persist(
            {
              // Every record that lists retired instances was written by
              // code that records edges.
              ...toPersistedState(node, node.dependsOn!),
              retired: instances.slice(index + 1),
            },
            `retired:${index}`,
          );
        },
      });
    } catch (error) {
      // Only the provider's refusal is explained. A failed state write, such
      // as a `VersionConflict`, an infrastructure error and a cancellation
      // keep their class, which the runtime and the deployment hold act on.
      if (
        writing ||
        InfrastructureError.is(error) ||
        error instanceof WorkflowCancelledError
      ) {
        throw error;
      }
      throw retiredDeleteError(opts, node.id, error, workflow);
    }
  }
}

function retiredDeleteError(
  opts: DurableWorkflowOptions,
  id: string,
  error: unknown,
  workflow: "deploy" | "destroy",
): Error {
  const reason = error instanceof Error ? error.message : String(error);
  // Destroy has deleted every record that depends on the record before it
  // reaches the record, except the other members of its cycle.
  if (workflow === "destroy") {
    return new Error(
      `Cannot delete a retired instance of ${id}: ${reason}. The instance and its record stay in state, and the next destroy tries to delete them again.`,
      { cause: error },
    );
  }
  const dependents = opts.resources
    .filter(
      (desired) => desired.id !== id && getDependencyIds(desired).includes(id),
    )
    .map((desired) => desired.id)
    .sort();
  const named =
    dependents.length > 0
      ? ` These resources in code depend on ${id}, and deploy treats them as using its replacement: ${dependents.join(", ")}. If one of them still uses the retired instance, change it so that deploy updates it.`
      : "";
  return new Error(
    `Cannot delete a retired instance of ${id}: ${reason}.${named} The instance stays retired, and the next deploy tries to delete it again.`,
    { cause: error },
  );
}

/**
 * Deletes the orphans and the retired instances, in reverse order of the
 * edges their records hold. For each record it reaches, the sweep:
 *
 * 1. Deletes the retired instances that the record lists.
 * 2. Deletes the record and its resource, if the record is an orphan.
 *
 * The edges of a record in code are not used, as the resource in code uses
 * the replacement of each retired instance.
 *
 * A state node whose type has no registry entry is left in place and surfaced
 * as a warning, because deleting it would need a resource class we cannot
 * resolve. Every orphan or retired instance it depends on is left in place
 * too, and the warning names them.
 */
export async function* sweepOrphans(
  step: DurableStep,
  opts: DurableWorkflowOptions,
): AsyncGenerator<any, void, any> {
  const scope = scopeStep(step, "notation:orphans");
  const resourceById = new Map(
    opts.resources.map((resource) => [resource.id, resource]),
  );
  const persisted = yield* scope.run("list", () => opts.state.values());
  const registry = workflowRegistry(opts);
  const { swept, edgesById } = sweptRecords(
    persisted,
    new Set(resourceById.keys()),
  );

  for (const sweep of sweepSteps(swept, registry, edgesById, new Set())) {
    const { node } = sweep;
    if (!sweep.Resource) {
      yield* warnUnregistered(
        scope,
        opts,
        node,
        sweep.keptDependencies,
        "deploy",
      );
      continue;
    }
    if (!sweep.orphan) {
      yield* deleteRetiredOf(
        step,
        opts,
        resourceById.get(node.id)!,
        sweep.Resource,
      );
      continue;
    }
    // Repeats the check of notation:validate, because the record may have
    // changed since validate ran before the hold.
    assertOrphanDeleteAllowed(registry, node);
    yield* deleteResource(
      scope.scope(encodeURIComponent(node.id)),
      await instantiateRecord(sweep.Resource, node),
      opts,
      "deploy",
    );
  }
}

/**
 * Deletes the retired instances that the record of `resource` lists, with
 * `Resource`, and leaves the record in place.
 */
async function* deleteRetiredOf(
  step: DurableStep,
  opts: DurableWorkflowOptions,
  resource: BaseResource,
  Resource: ResourceClass<any, any, any>,
): AsyncGenerator<any, void, any> {
  const scope = scopeStep(
    step,
    `notation:retired:${encodeURIComponent(resource.id)}`,
  );
  const session = yield* openStateSession(scope, opts, resource);
  if (!session.node) return;
  yield* deleteRetiredInstances(scope, opts, session, Resource, "deploy");
}

export async function* warnUnregistered(
  scope: DurableStepRunner,
  opts: DurableWorkflowOptions,
  node: StateNode,
  keptDependencies: string[],
  workflow: "deploy" | "destroy",
): AsyncGenerator<any, void, any> {
  const emit = durableEmitter(
    scope.scope(encodeURIComponent(node.id)),
    opts.emit,
  );
  yield* emit({
    level: "warn",
    event: "reconciler.orphan-deletion.skipped",
    reason: "resource-type-not-registered",
    workflow,
    resourceId: node.id,
    resourceType: node.type as ResourceType,
    keptDependencies,
  });
}

/**
 * Makes a resource from its state record, so that it can be deleted with no
 * declaration in code.
 */
export async function instantiateRecord(
  Resource: NonNullable<ReturnType<typeof resolveResourceClass>>,
  node: StateNode,
): Promise<BaseResource> {
  // The recorded config was checked when it was declared, and may not pass
  // a validator that has changed since.
  let resource!: BaseResource;
  await collectResourceGraph(
    () => {
      resource = new Resource(node.id, { config: node.config });
    },
    { declarationChecks: false },
  );
  resource.setOutput(node.output);
  return resource;
}

/**
 * Reads the persisted record once and binds the writes conditional on it.
 *
 * The snapshot is the precondition: it names the exact store instance and
 * version the record was read at, so a write made against it cannot land on a
 * record another writer has moved on.
 */
export async function* openStateSession(
  step: DurableStepRunner,
  opts: DurableWorkflowOptions,
  resource: BaseResource,
): AsyncGenerator<any, ResourceStateSession, any> {
  const snapshot = yield* step.run("persisted-record", () =>
    opts.state.snapshot(resource.id),
  );
  // Each write is made against `ref.current`, and moves it to the record
  // that the write left.
  const ref: SnapshotRef = { current: snapshot };
  const persist = persistResourceState(step, opts, resource, ref);
  const node = toStateNode(snapshot);
  if (!node) return { node: undefined, persist };

  return {
    node,
    persist,
    remove: removeResourceState(step, opts, resource, ref),
  };
}

function stateKey(
  step: DurableStepRunner,
  name: string,
  resource: BaseResource,
  stage?: string,
) {
  return `state:${name}:${resource.id}${stage ? `:${stage}` : ""}${step.stateKey ? `:${step.stateKey}` : ""}`;
}

/**
 * State writes go through the workflow store, never through the state backend:
 * the store stamps the write with the step that made it, so the applied-step
 * ledger and the state change commit together. Replaying then returns the
 * recorded result instead of retrying a compare-and-set that would now fail.
 *
 * Create and update take the same path. For a new resource the snapshot has
 * `null` state, so a writer that created the record first causes a version
 * conflict.
 */
function persistResourceState(
  step: DurableStepRunner,
  opts: DurableWorkflowOptions,
  resource: BaseResource,
  ref: SnapshotRef,
): PersistState {
  return async function* (next, stage) {
    const store = step.store(resourceStateStore, {
      id: opts.state.storeId(resource.id),
    });
    const { current } = ref;
    if (next === null) assertNoRetired(resource, current);
    const record =
      next === null || next.retired !== undefined
        ? next
        : { ...next, retired: current.state?.retired };
    const result = yield* store.updateFrom(
      stateKey(step, "persist", resource, stage),
      current,
      () => withoutEmptyRetired(record),
    );
    if (!result.updated) {
      throw new VersionConflict(
        resource.id,
        current.version,
        result.actualVersion,
      );
    }
    ref.current = {
      state: result.state,
      instanceId: current.instanceId,
      version: result.version,
    };
  };
}

function removeResourceState(
  step: DurableStepRunner,
  opts: DurableWorkflowOptions,
  resource: BaseResource,
  ref: SnapshotRef,
): RemoveState {
  return async function* () {
    const store = step.store(resourceStateStore, {
      id: opts.state.storeId(resource.id),
    });
    const { current } = ref;
    assertNoRetired(resource, current);
    const result = yield* store.deleteFrom(
      stateKey(step, "delete", resource),
      current,
    );
    if (!result.deleted) {
      throw new VersionConflict(
        resource.id,
        current.version,
        result.actualVersion,
      );
    }
  };
}

/**
 * Rule 2 of the retired instances: a record that lists retired instances is
 * not removed, as that would leave them in the provider with no record.
 */
function assertNoRetired(resource: BaseResource, snapshot: ResourceSnapshot) {
  if (!snapshot.state?.retired?.length) return;
  throw new Error(
    `Cannot remove the state record of ${resource.id}: it lists retired instances that deploy has not deleted yet`,
  );
}

// An empty list is left out, so that a record with no retired instances is
// written as before they existed.
function withoutEmptyRetired(
  record: PersistedResourceState | null,
): PersistedResourceState | null {
  if (!record || record.retired?.length) return record;
  const { retired: _, ...rest } = record;
  return rest as PersistedResourceState;
}
