import type { BaseResource, ResourceType } from "@notation/resource";
import { RevConflict, type StateNode } from "@notation/state";
import { type StandardSchemaV1, type StoreClient } from "@yieldstar/core";
import {
  RetryableError,
  defineStore,
  type WorkflowFn,
  type WorkflowStore,
} from "yieldstar";
import { buildResourceDepthLevels } from "./dependency-graph";
import { decideAction, type ResourceAction } from "./plan";
import {
  DEFAULT_READ_POLL_OPTIONS,
  DEFAULT_RETRY_OPTIONS,
  matchError,
  type PollOptions,
} from "./operations";
import {
  createMissingResourceRegistryMatchWarningEvent,
  createResourceRegistryFromResources,
  resolveResourceClass,
  type ResourceRegistry,
} from "./resource-registry";
import type { ReconcilerEventEmitter } from "./reconciler";

type StoredResourceState = Omit<StateNode, "rev">;
type CoordinationState = { holder: string | null };

const storedResourceStateSchema = plainObjectSchema<StoredResourceState>(
  "Stored resource state",
  (value) =>
    typeof value.id === "string" &&
    typeof value.type === "string" &&
    isPlainObject(value.config) &&
    isPlainObject(value.params) &&
    isPlainObject(value.output),
);
const coordinationStateSchema = plainObjectSchema<CoordinationState>(
  "Deployment coordination state",
  (value) =>
    "holder" in value &&
    (value.holder === null || typeof value.holder === "string"),
);

export const yieldStarResourceStateStore = defineStore(
  "notation/resource-state",
  storedResourceStateSchema,
);

export const yieldStarDeploymentCoordinationStore = defineStore(
  "notation/deployment-coordination",
  coordinationStateSchema,
);

type YieldStarStep = Parameters<WorkflowFn<any, any, any>>[0];

export type YieldStarReconciliationOptions = {
  deploymentId: string;
  executionId: string;
  resources: BaseResource[];
  state: YieldStarStateBackend;
  registry?: ResourceRegistry;
  dryRun?: boolean;
  driftDetection?: boolean;
  emit?: ReconcilerEventEmitter;
  retryOptions?: PollOptions;
  readPollOptions?: PollOptions;
};

/**
 * Reconciles resources as a custom YieldStar step. The caller owns the outer
 * workflow and runtime; Notation owns resource decisions and lifecycle calls.
 */
export async function* reconcileWithYieldStar(
  step: YieldStarStep,
  opts: YieldStarReconciliationOptions,
): AsyncGenerator<any, void, any> {
  const coordination = yield* step.store(yieldStarDeploymentCoordinationStore, {
    id: opts.deploymentId,
    initial: { holder: null },
  });

  yield* coordination.take(
    "notation:coordination:acquire",
    (state) => state.holder === null || state.holder === opts.executionId,
    (draft) => {
      draft.holder = opts.executionId;
    },
  );

  try {
    const resourceById = new Map(
      opts.resources.map((resource) => [resource.id, resource]),
    );

    for (const level of buildResourceDepthLevels(opts.resources)) {
      for (const resource of level) {
        yield* reconcileResource(step, resource, opts);
      }
    }

    const persisted = yield* step.run("notation:orphans:list", () =>
      opts.state.values(),
    );
    const registry =
      opts.registry ?? createResourceRegistryFromResources(opts.resources);

    for (const node of persisted) {
      if (resourceById.has(node.id)) continue;

      const Resource = resolveResourceClass(
        registry,
        node.type as ResourceType,
      );
      if (!Resource) {
        yield* emitDurably(
          step,
          `notation:orphan:${node.id}:warning`,
          opts.emit,
          () =>
            createMissingResourceRegistryMatchWarningEvent({
              workflow: "deploy",
              resourceId: node.id,
              resourceType: node.type as ResourceType,
            }),
        );
        continue;
      }

      const resource = new Resource({ id: node.id, config: node.config });
      resource.setOutput(node.output);
      yield* deleteResource(step, resource, opts, "orphan");
    }
  } finally {
    yield* coordination.update("notation:coordination:release", (draft) => {
      if (draft.holder === opts.executionId) draft.holder = null;
    });
  }
}

async function* reconcileResource(
  step: YieldStarStep,
  resource: BaseResource,
  opts: YieldStarReconciliationOptions,
): AsyncGenerator<any, void, any> {
  const prefix = `notation:resource:${resource.id}`;
  let stateNode = yield* step.run(`${prefix}:state:lookup`, () =>
    opts.state.get(resource.id),
  );
  let stateStore: WorkflowStore<StoredResourceState> | undefined;
  let snapshot:
    Awaited<ReturnType<YieldStarStateBackend["snapshot"]>> | undefined;
  if (stateNode) {
    stateStore = yield* openResourceState(step, opts.state, resource.id);
    snapshot = yield* stateStore.get(`${prefix}:state:get`);
    stateNode = toStateNode(snapshot);
  }
  if (stateNode) resource.setOutput(stateNode.output);

  const params = yield* step.run(`${prefix}:params`, () =>
    resource.getParams(),
  );
  let action: ResourceAction = decideAction({
    resource,
    stateNode: stateNode ?? undefined,
    params,
  });

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
    yield* emitDurably(step, `${prefix}:drift-detected`, opts.emit, () => ({
      level: "info",
      event: "reconciler.drift.detected",
      resourceId: resource.id,
      resourceType: resource.type,
      diff,
    }));
  }

  yield* emitDurably(step, `${prefix}:decision`, opts.emit, () => ({
    level: "info",
    event: "reconciler.deploy.decision",
    resourceId: resource.id,
    resourceType: resource.type,
    decision: action.decision,
  }));

  if (action.decision === "noop") return;
  if (opts.dryRun) return;

  if (action.decision === "create" || action.decision === "drift-recreate") {
    const primaryKey = yield* runProviderCall(
      step,
      `${prefix}:create`,
      () => resource.create(params),
      resource,
      opts.retryOptions,
    );
    resource.setOutput(params);
    if (primaryKey) resource.setOutput({ ...primaryKey, ...resource.output });
  } else {
    if (!resource.update) {
      yield* emitDurably(step, `${prefix}:update-skip`, opts.emit, () => ({
        level: "info",
        event: "reconciler.operation.lifecycle",
        operation: "update",
        status: "skip",
        resourceId: resource.id,
        resourceType: resource.type,
        reason: "update-not-implemented",
      }));
      return;
    }
    yield* runProviderCall(
      step,
      `${prefix}:update`,
      () =>
        resource.update!(
          resource.key,
          action.patch,
          params,
          resource.toState(resource.output),
        ),
      resource,
      opts.retryOptions,
    );
    resource.setOutput({ ...resource.key, ...params });
  }

  const read = yield* readRemote(
    step,
    resource,
    opts,
    `${prefix}:read-after-write`,
  );
  if (read.status === "found")
    resource.setOutput({ ...resource.output, ...read.output });

  const operation =
    action.decision === "create" || action.decision === "drift-recreate"
      ? "create"
      : "update";
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
    yield* step.store(yieldStarResourceStateStore, {
      id: opts.state.storeId(resource.id),
      initial: nextState,
    });
    return;
  }

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

async function* deleteResource(
  step: YieldStarStep,
  resource: BaseResource,
  opts: YieldStarReconciliationOptions,
  suffix: string,
): AsyncGenerator<any, void, any> {
  const prefix = `notation:${suffix}:${resource.id}`;
  const stateStore = yield* openResourceState(step, opts.state, resource.id);
  const snapshot = yield* stateStore.get(`${prefix}:state:get`);
  const stateNode = toStateNode(snapshot);
  resource.setOutput(stateNode.output);

  if (!opts.dryRun) {
    try {
      yield* runProviderCall(
        step,
        `${prefix}:delete`,
        () => resource.delete(resource.key, resource.toState(resource.output)),
        resource,
        opts.retryOptions,
      );
    } catch (error) {
      if (!matchError(error, resource.notFoundOnError)) throw error;
    }

    const deleted = yield* stateStore.deleteFrom(
      `${prefix}:state:delete`,
      snapshot,
    );
    if (!deleted.deleted)
      throw new RevConflict(resource.id, stateNode.rev, undefined);
  }
}

async function* readRemote(
  step: YieldStarStep,
  resource: BaseResource,
  opts: YieldStarReconciliationOptions,
  key: string,
): AsyncGenerator<
  any,
  | { status: "found"; output: Record<string, unknown> }
  | { status: "not-found" },
  any
> {
  if (!resource.read) {
    return {
      status: "found",
      output: { ...(await resource.getParams()), ...resource.output },
    };
  }

  try {
    const output = yield* step.run(key, async () => {
      const value = await resource.read!(resource.key);
      const unsettled = (resource.retryReadOnCondition ?? [])
        .filter(Boolean)
        .find((condition) => {
          const actual = value[condition!.key];
          return condition!.value === undefined
            ? !actual
            : actual !== condition!.value;
        });
      if (unsettled) {
        throw new RetryableError(unsettled.reason, {
          ...(opts.readPollOptions ?? DEFAULT_READ_POLL_OPTIONS),
        });
      }
      return value;
    });
    return { status: "found", output };
  } catch (error) {
    if (matchError(error, resource.notFoundOnError))
      return { status: "not-found" };
    throw error;
  }
}

function runProviderCall<T>(
  step: YieldStarStep,
  key: string,
  call: () => T | Promise<T>,
  resource: BaseResource,
  retryOptions?: PollOptions,
) {
  return step.run(key, async () => {
    try {
      return await call();
    } catch (error) {
      const matcher = matchError(error, resource.retryLaterOnError);
      if (matcher) {
        throw new RetryableError(matcher.reason, {
          ...(retryOptions ?? DEFAULT_RETRY_OPTIONS),
        });
      }
      throw error;
    }
  });
}

function openResourceState(
  step: YieldStarStep,
  state: YieldStarStateBackend,
  resourceId: string,
) {
  return step.store(yieldStarResourceStateStore, {
    id: state.storeId(resourceId),
  });
}

function emitDurably(
  step: YieldStarStep,
  key: string,
  emit: ReconcilerEventEmitter | undefined,
  event: () => Parameters<ReconcilerEventEmitter>[0],
) {
  return step.run(key, async () => {
    await emit?.(event());
  });
}

/** A Notation state backend backed by YieldStar 0.5 durable stores. */
export class YieldStarStateBackend {
  readonly #client: StoreClient;
  readonly #deploymentId: string;

  constructor(client: StoreClient, deploymentId: string) {
    this.#client = client;
    this.#deploymentId = deploymentId;
  }

  storeId(resourceId: string) {
    return `${this.#deploymentId}:${resourceId}`;
  }

  async get(id: string): Promise<StateNode | undefined> {
    const snapshot = await this.#tryGetSnapshot(this.storeId(id));
    return snapshot ? toStateNode(snapshot) : undefined;
  }

  /**
   * Reads a store snapshot in one round trip. A missing store is resource
   * absence, so a read failure is re-checked against the store listing before
   * it is allowed to propagate.
   */
  async #tryGetSnapshot(
    storeId: string,
  ): Promise<
    | { state: StoredResourceState; instanceId: string; version: number }
    | undefined
  > {
    try {
      return await this.#client.getStore({
        definition: yieldStarResourceStateStore,
        id: storeId,
      });
    } catch (error) {
      const ids = await this.#client.listStores(yieldStarResourceStateStore);
      if (!ids.includes(storeId)) return undefined;
      throw error;
    }
  }

  async has(id: string): Promise<boolean> {
    return (await this.get(id)) !== undefined;
  }

  async update(
    id: string,
    expectedRev: number,
    patch: Partial<StateNode>,
  ): Promise<{ rev: number }> {
    const storeId = this.storeId(id);
    const snapshot = await this.#tryGetSnapshot(storeId);
    if (!snapshot) {
      if (expectedRev !== 0) throw new RevConflict(id, expectedRev, undefined);
      const initial = { ...patch, id } as StoredResourceState;
      const created = await this.#client.getOrCreateStore({
        definition: yieldStarResourceStateStore,
        id: storeId,
        initial,
      });
      return { rev: created.version + 1 };
    }

    const actualRev = snapshot.version + 1;
    if (actualRev !== expectedRev)
      throw new RevConflict(id, expectedRev, actualRev);
    const result = await this.#client.updateStoreFrom({
      definition: yieldStarResourceStateStore,
      id: storeId,
      snapshot,
      updater: (draft) => {
        Object.assign(draft, withoutRev(patch));
      },
    });
    if (!result.updated) throw new RevConflict(id, expectedRev, undefined);
    return { rev: result.version + 1 };
  }

  async delete(id: string, expectedRev: number): Promise<void> {
    const storeId = this.storeId(id);
    const snapshot = await this.#tryGetSnapshot(storeId);
    if (!snapshot) {
      if (expectedRev !== 0) throw new RevConflict(id, expectedRev, undefined);
      return;
    }
    const actualRev = snapshot.version + 1;
    if (actualRev !== expectedRev)
      throw new RevConflict(id, expectedRev, actualRev);
    const result = await this.#client.deleteStoreFrom({
      definition: yieldStarResourceStateStore,
      id: storeId,
      snapshot,
    });
    if (!result.deleted) throw new RevConflict(id, expectedRev, undefined);
  }

  async values(): Promise<StateNode[]> {
    const prefix = `${this.#deploymentId}:`;
    const ids = await this.#client.listStores(yieldStarResourceStateStore);
    const snapshots = await Promise.all(
      ids
        .filter((id) => id.startsWith(prefix))
        .map((id) => this.#tryGetSnapshot(id)),
    );
    return snapshots
      .filter((snapshot) => snapshot !== undefined)
      .map(toStateNode);
  }

  snapshot(id: string) {
    return this.#client.getStore({
      definition: yieldStarResourceStateStore,
      id: this.storeId(id),
    });
  }

  async clear(): Promise<void> {
    const prefix = `${this.#deploymentId}:`;
    const ids = await this.#client.listStores(yieldStarResourceStateStore);
    await Promise.all(
      ids
        .filter((id) => id.startsWith(prefix))
        .map((id) =>
          this.#client.deleteStore({
            definition: yieldStarResourceStateStore,
            id,
          }),
        ),
    );
  }
}

function toStateNode(snapshot: {
  state: StoredResourceState;
  version: number;
}): StateNode {
  return { ...snapshot.state, rev: snapshot.version + 1 } as StateNode;
}

function withoutRev(patch: Partial<StateNode>): Partial<StoredResourceState> {
  const { rev: _rev, ...stored } = patch;
  return stored;
}

function plainObjectSchema<T extends Record<string, unknown>>(
  label: string,
  refine: (value: Record<string, unknown>) => boolean,
): StandardSchemaV1<T, T> {
  return {
    "~standard": {
      version: 1,
      vendor: "notation",
      validate(value) {
        if (!isPlainObject(value) || !refine(value)) {
          return { issues: [{ message: `${label} is invalid` }] };
        }
        return { value: value as T };
      },
    },
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
