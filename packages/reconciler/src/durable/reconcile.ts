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
  type ResourceType,
} from "@notation/resource";
import { VersionConflict, type StateNode } from "@notation/state";
import { buildDepthLevels, collectDependents } from "../dependency-graph";
import { createBlocksDelete } from "../delete-cascade";
import type { OperationLifecycleEvent } from "../events";
import { resolveResourceClass, workflowRegistry } from "../resource-registry";
import { assertSameType } from "../resource-type";
import {
  applyDriftDetection,
  createResourceOperation,
  deleteResourceOperation,
  readResourceOperation,
  updateResourceOperation,
  type CreateResourceParams,
  type PersistState,
  type RemoveState,
} from "../operations";
import {
  decideAction,
  getDependencyIds,
  hasSameEdges,
  recordedEdges,
  type ResourceAction,
} from "../plan";
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

export type ReconcileOptions = {
  /**
   * Added to the keys of the state writes. Deploy writes a member of a cycle
   * more than once, and each write needs its own key.
   */
  writeKey?: string;
  /** Leaves out the decision event when the decision is noop. */
  quietNoop?: boolean;
  /** Called with the decision before deploy acts on it. Throws to stop. */
  onDecision?: (decision: ResourceAction["decision"]) => void;
  /** Runs before a replacement deletes the resource. */
  beforeReplace?: () => AsyncGenerator<any, void, any>;
};

/**
 * Reconciles one resource: load the persisted record, decide, read the
 * remote when the decision needs it, announce the decision, then act. `step`
 * must already be scoped to the resource. Returns the decision.
 */
export async function* reconcileResource(
  step: DurableStepRunner,
  resource: BaseResource,
  opts: DurableDeployOptions,
  options: ReconcileOptions = {},
): AsyncGenerator<any, ResourceAction["decision"], any> {
  // Resolved once and then carried: deriveParams is user code and need not be
  // deterministic, so an operation resolving them again could persist params
  // other than the ones the decision was taken against. The step also pins
  // the answer across a replay.
  const params = yield* step.run("params", () => resource.getParams());
  await validateParams(resource, params, "deploy");
  const dependsOn = getDependencyIds(resource);

  const emit = durableEmitter(step, opts.emit);
  const session = yield* openStateSession(
    step,
    opts,
    resource,
    options.writeKey,
  );
  // Repeats the notation:validate check, because validate ran before the
  // hold and the record may have changed since.
  assertSameType(resource, session.node);
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

  options.onDecision?.(action.decision);
  if (action.decision !== "noop" || !options.quietNoop) {
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
  }

  const shared = {
    executionId: opts.executionId,
    resource,
    resourceParams: params,
    persistedOutput: session.node?.output,
    dependsOn,
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
      return action.decision;
    case "update":
    case "drift-update":
      yield* updateResourceOperation(step, {
        ...shared,
        patch: action.patch,
        persist: session.persist,
      });
      return action.decision;
    case "replace":
    case "drift-replace":
      if (!session.node) {
        throw new Error(
          `Cannot replace ${resource.id}: it has no state record`,
        );
      }
      if (options.beforeReplace) yield* options.beforeReplace();
      yield* replaceResource(step, opts, session, shared, options.writeKey);
      return action.decision;
    case "noop":
      if (!session.node) return action.decision;
      if (findMissingOutputs(resource, session.node.output)) {
        yield* recoverOutputs(step, opts, session, shared);
        return action.decision;
      }
      if (
        !opts.dryRun &&
        (!hasSameEdges(session.node, dependsOn) ||
          session.node.provider !== resource.provider)
      ) {
        yield* rewriteRecord(session, resource, dependsOn);
      }
      return action.decision;
  }
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
 * returns. The deploy fails while an output is still missing.
 */
async function* recoverOutputs(
  step: DurableStepRunner,
  opts: DurableDeployOptions,
  session: Extract<ResourceStateSession, { node: StateNode }>,
  shared: Omit<CreateResourceParams, "persist">,
): AsyncGenerator<any, void, any> {
  const { resource } = shared;
  if (resource.read) {
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
  }

  const missing = findMissingOutputs(resource, resource.output);
  if (!opts.dryRun && resource.read) {
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
  writeKey: string | undefined,
): AsyncGenerator<any, void, any> {
  yield* deleteBlockingDependents(
    step.scope("replace:dependents"),
    opts,
    shared.resource,
  );

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
    persist: createResourceState(createStep, opts, shared.resource, writeKey),
  });
}

/**
 * Deletes the resources that block the delete of `resource`: each depends on
 * it in state, or on another of them, and its type lists the type of what it
 * depends on in `blocksDeleteOf`. They are deleted in reverse order of the
 * edges in state. Each of them that is still declared has no record
 * afterwards, so deploy creates it again when it reaches it, after
 * `resource` has been created again. Each orphan among them is gone before
 * the sweep reaches it. Every other dependent stays in place, including one
 * with no class.
 *
 * Records are listed when the replacement starts. Deploy has written the
 * edges in code for every resource it has reached by then, and a resource it
 * has not reached still holds the edges of the resource that exists.
 */
async function* deleteBlockingDependents(
  step: DurableStepRunner,
  opts: DurableDeployOptions,
  resource: BaseResource,
): AsyncGenerator<any, void, any> {
  const registry = workflowRegistry(opts);
  // Skips listing state, which copies every record into the journal.
  const blockable = [...registry.values()].some((Class) =>
    Class.blocksDeleteOf.includes(resource.type),
  );
  if (!blockable) return;

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
      step.scope(encodeURIComponent(id)),
      await instantiateRecord(
        registry.get(record.type as ResourceType)!,
        record,
      ),
      opts,
      { reason: "dependency-replaced", replacedDependency: resource.id },
    );
  }
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
    dryRun: opts.dryRun,
    emit: (event) => emit({ ...event, ...cause }),
    maxOperationAttempts: opts.maxOperationAttempts,
    remove: session.remove,
  });
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
  /** See `ReconcileOptions.writeKey`. */
  writeKey?: string,
): AsyncGenerator<any, ResourceStateSession, any> {
  const snapshot = yield* step.run("persisted-record", () =>
    opts.state.snapshot(resource.id),
  );
  const persist = persistResourceState(
    step,
    opts,
    resource,
    snapshot,
    writeKey,
  );
  const node = toStateNode(snapshot);
  if (!node) return { node: undefined, persist };

  return {
    node,
    persist,
    remove: removeResourceState(step, opts, resource, snapshot, writeKey),
  };
}

function stateKey(name: string, resource: BaseResource, writeKey?: string) {
  return `state:${name}:${resource.id}${writeKey ? `:${writeKey}` : ""}`;
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
  snapshot: ResourceSnapshot,
  writeKey: string | undefined,
): PersistState {
  return async function* (next) {
    const store = step.store(resourceStateStore, {
      id: opts.state.storeId(resource.id),
    });
    const result = yield* store.updateFrom(
      stateKey("persist", resource, writeKey),
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
 * Writes the record of a resource that this execution removed earlier. The
 * write is unconditional, which is safe only because the deployment hold
 * keeps every other writer out for the length of the workflow.
 */
function createResourceState(
  step: DurableStepRunner,
  opts: DurableWorkflowOptions,
  resource: BaseResource,
  writeKey: string | undefined,
): PersistState {
  return async function* (next) {
    const store = step.store(resourceStateStore, {
      id: opts.state.storeId(resource.id),
    });
    yield* store.update(stateKey("create", resource, writeKey), () => next);
  };
}

function removeResourceState(
  step: DurableStepRunner,
  opts: DurableWorkflowOptions,
  resource: BaseResource,
  snapshot: ResourceSnapshot,
  writeKey: string | undefined,
): RemoveState {
  return async function* () {
    const store = step.store(resourceStateStore, {
      id: opts.state.storeId(resource.id),
    });
    const result = yield* store.deleteFrom(
      stateKey("delete", resource, writeKey),
      snapshot,
    );
    if (!result.deleted) {
      throw new VersionConflict(
        resource.id,
        snapshot.version,
        result.actualVersion,
      );
    }
  };
}
