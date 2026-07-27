import {
  ResourceNotReadyError,
  type BaseResource,
  type ResourceType,
} from "@notation/resource";
import { RevConflict } from "@notation/state";
import {
  createMissingResourceRegistryMatchWarningEvent,
  createResourceRegistryFromResources,
  resolveResourceClass,
} from "../resource-registry";
import { decideAction, type DriftRead, type ResourceAction } from "../plan";
import { emitEvent, emitLifecycle } from "./emit";
import type { DurableStateBackend } from "./state-backend";
import {
  resourceStateStore,
  toStateNode,
  type StoredResourceState,
} from "./stores";
import {
  DEFAULT_READ_POLL_OPTIONS,
  DEFAULT_RETRY_OPTIONS,
  type DurableDeployOptions,
  type DurableOperationOptions,
  type PollOptions,
} from "./types";
import {
  RetryableError,
  type DurableStep,
  type WorkflowStore,
} from "./yieldstar";

export async function* reconcileResource(
  step: DurableStep,
  resource: BaseResource,
  opts: DurableDeployOptions,
): AsyncGenerator<any, void, any> {
  const prefix = `notation:resource:${resource.id}`;

  // Hydrate the resource from persisted state. The snapshot is kept so later
  // writes can be conditional on the exact instance identity and version that
  // was read here.
  let stateNode = yield* step.run(`${prefix}:state:lookup`, () =>
    opts.state.get(resource.id),
  );
  let stateStore: WorkflowStore<StoredResourceState> | undefined;
  let snapshot:
    Awaited<ReturnType<DurableStateBackend["snapshot"]>> | undefined;
  if (stateNode) {
    stateStore = yield* openResourceState(step, opts.state, resource.id);
    snapshot = yield* stateStore.get(`${prefix}:state:get`);
    stateNode = toStateNode(snapshot);
  }
  if (stateNode) resource.setOutput(stateNode.output);

  // Decide the operation from desired params vs persisted state.
  const params = yield* step.run(`${prefix}:params`, () =>
    resource.getParams(),
  );
  let action: ResourceAction = decideAction({
    resource,
    stateNode: stateNode ?? undefined,
    params,
  });

  // A noop is only trusted after the remote is read back: the provider may
  // have drifted from persisted state, which upgrades the decision.
  if (action.decision === "noop" && (opts.driftDetection ?? true)) {
    const remote = yield* readRemote(
      step,
      resource,
      opts,
      `${prefix}:drift-read`,
    );
    action = decideAction({
      resource,
      stateNode: stateNode ?? undefined,
      params,
      driftRead: remote,
    });
  }

  if (action.decision === "drift-update") {
    const diff = action.patch;
    yield* emitEvent(step, `${prefix}:drift-detected`, opts.emit, () => ({
      level: "info",
      event: "reconciler.drift.detected",
      resourceId: resource.id,
      resourceType: resource.type,
      diff,
    }));
  }

  yield* emitEvent(step, `${prefix}:decision`, opts.emit, () => ({
    level: "info",
    event: "reconciler.deploy.decision",
    resourceId: resource.id,
    resourceType: resource.type,
    decision: action.decision,
  }));

  if (action.decision === "noop") return;
  const operation =
    action.decision === "create" || action.decision === "drift-recreate"
      ? "create"
      : "update";
  const patch = "patch" in action ? action.patch : {};
  yield* emitLifecycle(
    step,
    `${prefix}:${operation}:start`,
    opts.emit,
    operation,
    "start",
    resource,
  );
  if (opts.dryRun) {
    yield* emitLifecycle(
      step,
      `${prefix}:${operation}:dry-run`,
      opts.emit,
      operation,
      "dry-run",
      resource,
    );
    return;
  }

  try {
    // Checkpoint successful provider calls. Provider mutations must be
    // idempotent because a crash before the checkpoint can repeat them.
    if (operation === "create") {
      const primaryKey = yield* runResourceMutation(
        step,
        `${prefix}:create`,
        () => resource.create(params),
        opts.retryOptions,
      );
      resource.setOutput(params);
      if (primaryKey) resource.setOutput({ ...primaryKey, ...resource.output });
    } else {
      if (!resource.update) {
        yield* emitLifecycle(
          step,
          `${prefix}:update:skip`,
          opts.emit,
          "update",
          "skip",
          resource,
          { reason: "update-not-implemented" },
        );
        return;
      }
      yield* runResourceMutation(
        step,
        `${prefix}:update`,
        () =>
          resource.update!(
            resource.key,
            patch,
            params,
            resource.toState(resource.output),
          ),
        opts.retryOptions,
      );
      resource.setOutput({ ...resource.key, ...params });
    }

    // Read back the remote so persisted output reflects provider-assigned
    // values, then persist conditionally against the snapshot read above.
    const read = yield* readRemote(
      step,
      resource,
      opts,
      `${prefix}:read-after-write`,
      { retryAbsent: true },
    );
    if (read.kind === "present")
      resource.setOutput({ ...resource.output, ...read.output });

    const nextState: StoredResourceState = {
      id: resource.id,
      groupId: resource.groupId,
      groupType: resource.groupType,
      type: resource.type,
      lastOperation: operation,
      lastOperationAt: new Date().toISOString(),
      config: resource.config,
      params: resource.toState(params),
      output: resource.toState(resource.output),
    };

    if (!stateStore || !snapshot) {
      yield* step.store(resourceStateStore, {
        id: opts.state.storeId(resource.id),
        initial: nextState,
      });
    } else {
      const result = yield* stateStore.updateFrom(
        `${prefix}:state:persist`,
        snapshot,
        () => nextState,
      );
      if (!result.updated)
        throw new RevConflict(
          resource.id,
          stateNode?.rev ?? 0,
          result.actualVersion + 1,
        );
    }

    yield* emitLifecycle(
      step,
      `${prefix}:${operation}:success`,
      opts.emit,
      operation,
      "success",
      resource,
    );
  } catch (error) {
    yield* emitLifecycle(
      step,
      `${prefix}:${operation}:error`,
      opts.emit,
      operation,
      "error",
      resource,
      { error },
    );
    throw error;
  }
}

export async function* deleteResource(
  step: DurableStep,
  resource: BaseResource,
  opts: DurableOperationOptions,
  suffix: string,
): AsyncGenerator<any, void, any> {
  const prefix = `notation:${suffix}:${resource.id}`;

  // Hydrate output from persisted state; the delete call needs the primary
  // key and the state removal must be conditional on this exact snapshot.
  const stateStore = yield* openResourceState(step, opts.state, resource.id);
  const snapshot = yield* stateStore.get(`${prefix}:state:get`);
  const stateNode = toStateNode(snapshot);
  resource.setOutput(stateNode.output);

  yield* emitLifecycle(
    step,
    `${prefix}:delete:start`,
    opts.emit,
    "delete",
    "start",
    resource,
  );

  if (opts.dryRun) {
    yield* emitLifecycle(
      step,
      `${prefix}:delete:dry-run`,
      opts.emit,
      "delete",
      "dry-run",
      resource,
    );
    return;
  }

  try {
    yield* runResourceMutation(
      step,
      `${prefix}:delete`,
      () => resource.delete(resource.key, resource.toState(resource.output)),
      opts.retryOptions,
    );

    // State is removed only after the provider delete completes, and only if
    // the store still matches the snapshot read before deleting.
    const deleted = yield* stateStore.deleteFrom(
      `${prefix}:state:delete`,
      snapshot,
    );
    if (!deleted.deleted)
      throw new RevConflict(resource.id, stateNode.rev, undefined);
    yield* emitLifecycle(
      step,
      `${prefix}:delete:success`,
      opts.emit,
      "delete",
      "success",
      resource,
    );
  } catch (error) {
    yield* emitLifecycle(
      step,
      `${prefix}:delete:error`,
      opts.emit,
      "delete",
      "error",
      resource,
      { error },
    );
    throw error;
  }
}

export async function* readRemote(
  step: DurableStep,
  resource: BaseResource,
  opts: DurableOperationOptions,
  key: string,
  behaviour: { retryAbsent?: boolean } = {},
): AsyncGenerator<any, DriftRead, any> {
  if (!resource.read) {
    yield* emitLifecycle(
      step,
      `${key}:skip`,
      opts.emit,
      "read",
      "skip",
      resource,
      {
        reason: "read-not-implemented",
      },
    );
    return {
      kind: "present",
      output: { ...(await resource.getParams()), ...resource.output },
    };
  }

  yield* emitLifecycle(
    step,
    `${key}:start`,
    opts.emit,
    "read",
    "start",
    resource,
  );
  try {
    const result = yield* step.run(key, async () => {
      try {
        const output = await resource.read!(resource.key);
        if (output === undefined && behaviour.retryAbsent) {
          throw new RetryableError("Waiting for resource to become visible", {
            ...(opts.readPollOptions ?? DEFAULT_READ_POLL_OPTIONS),
          });
        }
        // Absence is null rather than undefined so that it survives the
        // step's JSON round-trip when the run is replayed.
        return output ?? null;
      } catch (error) {
        // A tagged not-ready condition is the provider telling us to wait.
        // Everything else is a genuine failure and must surface.
        if (ResourceNotReadyError.is(error)) {
          throw new RetryableError(error.message, {
            ...(opts.readPollOptions ?? DEFAULT_READ_POLL_OPTIONS),
          });
        }
        throw error;
      }
    });
    if (result === null) {
      yield* emitLifecycle(
        step,
        `${key}:absent`,
        opts.emit,
        "read",
        "skip",
        resource,
        { reason: "resource-absent" },
      );
      return { kind: "absent" };
    }
    yield* emitLifecycle(
      step,
      `${key}:success`,
      opts.emit,
      "read",
      "success",
      resource,
    );
    return { kind: "present", output: result };
  } catch (error) {
    yield* emitLifecycle(
      step,
      `${key}:error`,
      opts.emit,
      "read",
      "error",
      resource,
      {
        error,
      },
    );
    throw error;
  }
}

/**
 * Runs a resource mutation in a durable step and adapts resource retry
 * signals to the workflow runtime.
 */
export function runResourceMutation<T>(
  step: DurableStep,
  key: string,
  call: () => T | Promise<T>,
  retryOptions?: PollOptions,
) {
  return step.run(key, async () => {
    try {
      return await call();
    } catch (error) {
      if (ResourceNotReadyError.is(error)) {
        throw new RetryableError(error.message, {
          ...(retryOptions ?? DEFAULT_RETRY_OPTIONS),
        });
      }
      throw error;
    }
  });
}

/**
 * Deletes persisted resources that are no longer in the desired set. A state
 * node whose type has no registry entry is left in place and surfaced as a
 * warning, because deleting it would need a resource class we cannot resolve.
 */
export async function* sweepOrphans(
  step: DurableStep,
  opts: DurableOperationOptions,
  params: {
    workflow: "deploy" | "destroy";
    listKey: string;
    warningKey: (nodeId: string) => string;
    deleteSuffix: string;
  },
): AsyncGenerator<any, void, any> {
  const resourceById = new Map(
    opts.resources.map((resource) => [resource.id, resource]),
  );
  const persisted = yield* step.run(params.listKey, () => opts.state.values());
  const registry =
    opts.registry ?? createResourceRegistryFromResources(opts.resources);

  for (const node of persisted) {
    if (resourceById.has(node.id)) continue;

    const Resource = resolveResourceClass(registry, node.type as ResourceType);
    if (!Resource) {
      yield* emitEvent(step, params.warningKey(node.id), opts.emit, () =>
        createMissingResourceRegistryMatchWarningEvent({
          workflow: params.workflow,
          resourceId: node.id,
          resourceType: node.type as ResourceType,
        }),
      );
      continue;
    }

    const resource = new Resource({ id: node.id, config: node.config });
    resource.setOutput(node.output);
    yield* deleteResource(step, resource, opts, params.deleteSuffix);
  }
}

export function openResourceState(
  step: DurableStep,
  state: DurableStateBackend,
  resourceId: string,
) {
  return step.store(resourceStateStore, {
    id: state.storeId(resourceId),
  });
}
