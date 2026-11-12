/**
 * Per-resource reconciliation: converging, deleting, and sweeping single
 * resources, each built on one read of the resource's persisted record and
 * writes conditional on that read.
 */
import {
  SchemaStructureError,
  assertRequiredOutputs,
  collectResourceGraph,
  validateParams,
  type BaseResource,
  type ResourceGroupRef,
  type ResourceDeletion,
  type ResourceType,
} from "@notation/resource";
import {
  VersionConflict,
  isCreatingRecord,
  type StateNode,
} from "@notation/state";
import { remainingDependencies } from "../cycles";
import { buildDepthLevels, collectDependents } from "../dependency-graph";
import { createBlocksDelete } from "../delete-cascade";
import type { EmitStep, OperationLifecycleEvent } from "../events";
import { resolveResourceClass, workflowRegistry } from "../resource-registry";
import { assertSameType } from "../resource-type";
import {
  applyDriftDetection,
  createResourceOperation,
  deleteResourceOperation,
  readResourceOperation,
  updateResourceOperation,
  type CreateResourceParams,
  type PersistStage,
  type PersistState,
  type RemoveState,
} from "../operations";
import {
  decideAction,
  decideDriftAction,
  getDependencyIds,
  hasSameEdges,
  recordedEdges,
  type DriftRead,
  type ResourceAction,
} from "../plan";
import { assertOutputsRecoverable } from "../planner";
import { durableEmitter, scopeStep, type DurableStepRunner } from "./step";
import {
  resourceStateStore,
  toStateNode,
  type ResourceSnapshot,
} from "./stores";
import type { DurableDeployOptions, DurableWorkflowOptions } from "./types";
import type { DurableStep } from "./sdk";

/**
 * A read of a resource's persisted record, together with the writes that are
 * conditional on that exact read. `remove` exists only alongside a `node`:
 * a record that was never read cannot be removed safely.
 */
export type ResourceStateSession =
  | { node: undefined; persist: PersistState; remove?: never }
  | { node: StateNode; persist: PersistState; remove: RemoveState };

type SnapshotRef = { current: ResourceSnapshot };

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
   * Called when deploy replaces the resource, after the delete, with the IDs
   * of the dependents that the replacement deleted because they block the
   * delete. Deploy creates the resource without the contributions that
   * depend on one of the returned resources.
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
  opts: DurableDeployOptions,
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
  const params = yield* step.run("params", () =>
    resource.getParams({
      excludeContributionsFrom: options.excludeContributionsFrom,
    }),
  );
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
      ? { replaceFields: action.replaceFields }
      : {}),
    ...(placeholder ? { placeholder: true as const } : {}),
  });
}

/**
 * Carries out a decision against the record that `session` read.
 */
async function* applyAction(
  step: DurableStepRunner,
  opts: DurableDeployOptions,
  session: ResourceStateSession,
  action: ResourceAction,
  shared: Omit<CreateResourceParams, "persist">,
  replaceWithout?: ReconcileOptions["replaceWithout"],
): AsyncGenerator<any, void, any> {
  const { resource, dependsOn } = shared;
  switch (action.decision) {
    case "create":
    case "drift-recreate": {
      const { reclaimed } = yield* createResourceOperation(step, {
        ...shared,
        persist: session.persist,
      });
      if (reclaimed) {
        yield* reconcileReclaimed(step, opts, shared, replaceWithout);
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
      yield* replaceResource(step, opts, session, shared, replaceWithout);
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
          session.node.provider !== resource.provider)
      ) {
        yield* rewriteRecord(session, resource, dependsOn);
      }
      return;
  }
}

/**
 * Compares a resource that create took over with the desired params, and
 * updates, replaces or keeps it, as for any recorded resource. Its record
 * was just written from a read, so drift detection is skipped. The record
 * is read again, because the session of the create does not hold what the
 * takeover wrote.
 */
async function* reconcileReclaimed(
  parent: DurableStepRunner,
  opts: DurableDeployOptions,
  shared: Omit<CreateResourceParams, "persist">,
  replaceWithout?: ReconcileOptions["replaceWithout"],
): AsyncGenerator<any, void, any> {
  // The state key keeps the writes that follow a takeover apart from the
  // writes of the create that took the resource over. It nests, because a
  // replace that follows a takeover can end in another takeover. It must
  // not equal a persist stage, which sits at the same place in the key.
  const step = parent.scope(
    "reclaimed",
    [parent.stateKey, "after-takeover"].filter(Boolean).join(":"),
  );
  const { resource, resourceParams } = shared;
  const reclaimed = yield* openStateSession(step, opts, resource);
  const action = decideAction({
    resource,
    stateNode: reclaimed.node,
    params: resourceParams,
  });
  const emit = durableEmitter(step, opts.emit);
  yield* emitDecision(emit, resource, action);
  yield* applyAction(
    step,
    opts,
    reclaimed,
    action,
    {
      ...shared,
      // Names the effects of a create that replaces the resource apart from
      // those of the create that took it over. It is built from the ID of
      // that create, so that it differs at each level of nesting.
      executionId: `${shared.executionId}/reclaimed`,
      emit,
      persistedOutput: reclaimed.node?.output,
      prior: reclaimed.node,
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
  opts: DurableDeployOptions,
  session: Extract<ResourceStateSession, { node: StateNode }>,
  shared: Omit<CreateResourceParams, "persist">,
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
    const { version: _, ...record } = session.node;
    yield* session.persist({
      ...record,
      group: (record.group ?? null) as ResourceGroupRef | null,
      output: resource.toState(resource.output),
      dependsOn: shared.dependsOn,
    });
  }
  if (missing) throw missing;
}

/**
 * Updates `dependsOn` and `provider` in the record, without calling the
 * resource's update operation.
 */
async function* rewriteRecord(
  session: Extract<ResourceStateSession, { node: StateNode }>,
  resource: BaseResource,
  dependsOn: string[],
): AsyncGenerator<any, void, any> {
  const { version: _, ...record } = session.node;
  yield* session.persist({
    ...record,
    provider: resource.provider,
    group: (record.group ?? null) as ResourceGroupRef | null,
    dependsOn,
  });
}

/**
 * `shared` with the params and edges of the resource without the
 * contributions that depend on one of `excluded`.
 */
async function* withoutContributions(
  step: DurableStepRunner,
  shared: Omit<CreateResourceParams, "persist">,
  excluded: ReadonlySet<BaseResource>,
): AsyncGenerator<any, Omit<CreateResourceParams, "persist">, any> {
  const { resource } = shared;
  const params = yield* step.run("replace:params", () =>
    resource.getParams({ excludeContributionsFrom: excluded }),
  );
  await validateParams(resource, params, "deploy");
  return {
    ...shared,
    resourceParams: params,
    dependsOn: getDependencyIds(
      resource,
      remainingDependencies(resource, excluded),
    ),
  };
}

/**
 * Deletes the resource and then creates it again, each part in its own scope.
 * Deleting first is deliberate: a resource usually takes its physical name
 * from its params, so a new one created beside the old would collide with it.
 * The dependents that block the delete are deleted first, and deploy creates
 * them again when it reaches them.
 * The new record is a new store instance, so observers can tell the
 * replacement from the resource it replaced.
 */
async function* replaceResource(
  step: DurableStepRunner,
  opts: DurableDeployOptions,
  session: Extract<ResourceStateSession, { node: StateNode }>,
  shared: Omit<CreateResourceParams, "persist">,
  replaceWithout?: ReconcileOptions["replaceWithout"],
): AsyncGenerator<any, void, any> {
  const deleted = yield* deleteBlockingDependents(
    step.scope("replace:dependents"),
    opts,
    shared.resource,
  );

  const deleteStep = step.scope("replace:delete");
  yield* deleteResourceOperation(deleteStep, {
    resource: shared.resource,
    deletion: yield* readDeletion(deleteStep, opts, shared.resource),
    dryRun: shared.dryRun,
    emit: durableEmitter(deleteStep, opts.emit),
    maxOperationAttempts: shared.maxOperationAttempts,
    remove: session.remove,
  });

  const excluded = replaceWithout?.(new Set(deleted));
  const created = excluded?.size
    ? yield* withoutContributions(step, shared, excluded)
    : shared;

  const createStep = step.scope("replace:create");
  // The delete removed the store instance that `session` read, so a write
  // against it would conflict. The record is read again for the create.
  const recreated = yield* openStateSession(createStep, opts, shared.resource);
  const { reclaimed } = yield* createResourceOperation(createStep, {
    ...created,
    emit: durableEmitter(createStep, opts.emit),
    // The persisted output describes the resource that was just deleted.
    persistedOutput: undefined,
    // The record was removed with the resource it describes.
    prior: undefined,
    replaces: session.node,
    persist: recreated.persist,
  });
  // No `replaceWithout`: the params in `created` already leave out the
  // contributions that a replace of the resource must leave out.
  if (reclaimed) yield* reconcileReclaimed(createStep, opts, created);
}

/**
 * Deletes the resources that block the delete of `resource`: each depends on
 * it in state, or on another of them, and its type lists the type of what it
 * depends on in `blocksDeleteOf`. They are deleted in reverse order of the
 * edges in state. Each of them that is still declared has no record
 * afterwards, so deploy creates it again when it reaches it, after
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
  opts: DurableDeployOptions,
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
      records.map((node) => [node.id, recordedEdges(node, resourceById)]),
    ),
    createBlocksDelete(records, registry),
  );

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
      { reason: "dependency-replaced", replacedDependency: resource.id },
    );
  }
  return dependents;
}

/**
 * Deletes one resource. A resource with no persisted record was never created
 * — or has already been deleted — and is skipped, which is also what makes
 * the sweep of a partly-deleted deployment idempotent. `step` must already be
 * scoped to the resource.
 * If the record's type differs from `declared`'s type, the record's own class
 * deletes it.
 */
export async function* deleteResource(
  step: DurableStepRunner,
  declared: BaseResource,
  opts: DurableWorkflowOptions,
  /** Added to the delete's lifecycle events. */
  cause: Pick<OperationLifecycleEvent, "reason" | "replacedDependency"> = {},
): AsyncGenerator<any, void, any> {
  const session = yield* openStateSession(step, opts, declared);
  if (!session.node) return;
  let resource = declared;
  if (session.node.type !== declared.type) {
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
    resource = await instantiateRecord(Resource, session.node);
  }
  resource.setOutput(session.node.output);

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
 * type takes it: the resources whose state records depend on it now. Listed
 * just before the delete, so that it leaves out the dependents that deploy
 * has already deleted. The step returns only the dependents, as its result
 * is copied into the journal.
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
    (await opts.state.values())
      .filter(
        (node) =>
          node.id !== resource.id &&
          recordedEdges(node, resourceById).includes(resource.id),
      )
      .map(({ id, type, params }) => ({ id, type, params })),
  );
  return { dependents };
}

/**
 * Deletes persisted resources that are no longer in the desired set, in
 * reverse order of the edges their records hold.
 *
 * A state node whose type has no registry entry is left in place and surfaced
 * as a warning, because deleting it would need a resource class we cannot
 * resolve. Every orphan it depends on is left in place too, and the warning
 * names them. In destroy, desired resources it depends on are kept too, and
 * so is a desired resource whose record's type has no class.
 *
 * Returns the IDs of all records left in place.
 */
export async function* sweepOrphans(
  step: DurableStep,
  opts: DurableWorkflowOptions,
  workflow: "deploy" | "destroy",
): AsyncGenerator<any, Set<string>, any> {
  const scope = scopeStep(step, "notation:orphans");
  const resourceById = new Map(
    opts.resources.map((resource) => [resource.id, resource]),
  );
  const persisted = yield* scope.run("list", () => opts.state.values());
  const registry = workflowRegistry(opts);

  const orphans = persisted.filter((node) => !resourceById.has(node.id));
  const edgesById = new Map(
    orphans.map((node) => [node.id, node.dependsOn ?? []]),
  );
  // Destroy deletes the desired set after the sweep, so an edge from a
  // skipped orphan to a desired resource keeps that resource too. Deploy does
  // not delete desired resources, so it follows edges between orphans only.
  if (workflow === "destroy") {
    for (const resource of opts.resources) {
      edgesById.set(resource.id, getDependencyIds(resource));
    }
  }
  const kept = new Set<string>();

  if (workflow === "destroy") {
    for (const node of persisted) {
      const resource = resourceById.get(node.id);
      if (!resource || resource.type === node.type) continue;
      if (resolveResourceClass(registry, node.type as ResourceType)) continue;
      yield* skipUnregistered(scope, opts, node, edgesById, kept, workflow);
    }
  }

  for (const node of orderOrphanDeletes(orphans)) {
    const nodeScope = scope.scope(encodeURIComponent(node.id));

    const Resource = resolveResourceClass(registry, node.type as ResourceType);
    // An unregistered orphan warns even when another orphan already keeps
    // it, so that the warnings name every type the sweep could not delete.
    if (!Resource) {
      yield* skipUnregistered(scope, opts, node, edgesById, kept, workflow);
      continue;
    }
    if (kept.has(node.id)) continue;

    const resource = await instantiateRecord(Resource, node);
    yield* deleteResource(nodeScope, resource, opts);
  }

  return kept;
}

async function* skipUnregistered(
  scope: DurableStepRunner,
  opts: DurableWorkflowOptions,
  node: StateNode,
  edgesById: Map<string, string[]>,
  kept: Set<string>,
  workflow: "deploy" | "destroy",
): AsyncGenerator<any, void, any> {
  const keptDependencies = collectDependencies(node, edgesById);
  kept.add(node.id);
  for (const id of keptDependencies) kept.add(id);

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
async function instantiateRecord(
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
 * Orders orphans so that each is deleted before the orphans it depends on.
 * An edge to a resource that is not an orphan is ignored.
 *
 * A record with no edges was written before edges were recorded, and keeps
 * its storage order among the records it has no edges to. Orphans that form
 * a cycle, and the orphans that depend on them, cannot be ordered, and are
 * deleted first, in storage order.
 */
function orderOrphanDeletes(orphans: StateNode[]): StateNode[] {
  const { levels, unordered } = buildDepthLevels(
    orphans,
    (node) => node.id,
    (node) => node.dependsOn ?? [],
  );
  return [...unordered, ...levels.reverse().flat()];
}

/**
 * The resources that `node` depends on, directly or through each other,
 * among those that `edgesById` holds edges for.
 */
function collectDependencies(
  node: StateNode,
  edgesById: Map<string, string[]>,
): string[] {
  const found = new Set<string>();
  const pending = [...(node.dependsOn ?? [])];
  while (pending.length > 0) {
    const id = pending.pop()!;
    const edges = edgesById.get(id);
    if (found.has(id) || id === node.id || !edges) continue;
    found.add(id);
    pending.push(...edges);
  }
  return [...found].sort();
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
    const result = yield* store.updateFrom(
      stateKey(step, "persist", resource, stage),
      current,
      () => next,
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
