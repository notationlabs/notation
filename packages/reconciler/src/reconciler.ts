import type { BaseResource, ResourceType } from "@notation/resource";
import { RevConflict, type State, type StateNode } from "@notation/state";
import { setTimeout as sleep } from "node:timers/promises";
import { buildResourceDepthLevels } from "./dependency-graph";
import {
  decideAction,
  getDependencyIds,
  resolvePlanParams,
  type DriftRead,
  type Plan,
  type PlanNode,
  type ResourceAction,
} from "./plan";
import {
  createResourceOperation,
  deleteResourceOperation,
  readDriftOperation,
  type OperationEventEmitter,
  type PersistState,
  type RemoveState,
  type StepRunner,
  updateResourceOperation,
} from "./operations";
import {
  createMissingResourceRegistryMatchWarningEvent,
  createResourceRegistryFromResources,
  resolveResourceClass,
  type ResourceRegistry,
} from "./resource-registry";
import { toEmitStep, type ReconcilerEventEmitter } from "./events";
import { createPlan } from "./planner";
import { createStepRunner, runOperation } from "./step-runner";

export type {
  ReconcilerDeployEvent,
  ReconcilerDriftDetectedEvent,
  ReconcilerEvent,
  ReconcilerEventEmitter,
} from "./events";
export { createStepRunner, runOperation } from "./step-runner";

export type ReconcilerState = Pick<
  State,
  "get" | "update" | "delete" | "values" | "lease"
>;

export type ReconcilerOptions = {
  state: ReconcilerState;
  registry?: ResourceRegistry;
  dryRun?: boolean;
  driftDetection?: boolean;
  emit?: ReconcilerEventEmitter;
  maxOperationAttempts?: number;
  mutationLeaseTtl?: number;
};

export type DeployOptions = {
  dryRun?: boolean;
  driftDetection?: boolean;
};

export type DestroyOptions = {
  dryRun?: boolean;
};

export type RefreshOptions = {
  dryRun?: boolean;
};

export type PlanOptions = {
  driftDetection?: boolean;
};

export class Reconciler {
  readonly #state: ReconcilerState;
  readonly #registry?: ResourceRegistry;
  readonly #defaultDryRun: boolean;
  readonly #defaultDriftDetection: boolean;
  readonly #emit?: ReconcilerEventEmitter;
  readonly #emitStep?: OperationEventEmitter;
  readonly #maxOperationAttempts?: number;
  readonly #mutationLeaseTtl: number;
  readonly #stepRunner: StepRunner;

  constructor(opts: ReconcilerOptions) {
    this.#state = opts.state;
    this.#registry = opts.registry;
    this.#defaultDryRun = opts.dryRun ?? false;
    this.#defaultDriftDetection = opts.driftDetection ?? true;
    this.#emit = opts.emit;
    // Operations emit through a step seam; in process that is a plain await.
    this.#emitStep = opts.emit ? toEmitStep(opts.emit) : undefined;
    this.#maxOperationAttempts = opts.maxOperationAttempts;
    this.#mutationLeaseTtl = opts.mutationLeaseTtl ?? 30_000;
    this.#stepRunner = createStepRunner();
  }

  async deploy(
    resources: BaseResource[],
    opts: DeployOptions = {},
  ): Promise<void> {
    const dryRun = opts.dryRun ?? this.#defaultDryRun;
    const driftDetection = opts.driftDetection ?? this.#defaultDriftDetection;
    const resourceById = new Map(
      resources.map((resource) => [resource.id, resource]),
    );

    const dependencyLevels = buildResourceDepthLevels(resources);
    for (const level of dependencyLevels) {
      await Promise.all(
        level.map((resource) =>
          this.#deployResource(resource, dryRun, driftDetection),
        ),
      );
    }

    await this.#deleteOrphans(resources, resourceById, dryRun, "deploy");
  }

  async plan(resources: BaseResource[], opts: PlanOptions = {}): Promise<Plan> {
    return createPlan({
      resources,
      state: this.#state,
      driftDetection: opts.driftDetection ?? this.#defaultDriftDetection,
      emit: this.#emit,
      maxOperationAttempts: this.#maxOperationAttempts,
    });
  }

  async destroy(
    resources: BaseResource[],
    opts: DestroyOptions = {},
  ): Promise<void> {
    const dryRun = opts.dryRun ?? this.#defaultDryRun;
    const dependencyLevels = buildResourceDepthLevels(resources);

    for (
      let levelIndex = dependencyLevels.length - 1;
      levelIndex >= 0;
      levelIndex -= 1
    ) {
      const level = dependencyLevels[levelIndex]!;
      await Promise.all(
        level.map((resource) => this.#destroyResource(resource, dryRun)),
      );
    }
  }

  async refresh(
    resources: BaseResource[],
    opts: RefreshOptions = {},
  ): Promise<void> {
    const dryRun = opts.dryRun ?? this.#defaultDryRun;
    const resourceById = new Map(
      resources.map((resource) => [resource.id, resource]),
    );

    await this.#deleteOrphans(resources, resourceById, dryRun, "refresh");
  }

  async #deployResource(
    resource: BaseResource,
    dryRun: boolean,
    driftDetection: boolean,
  ) {
    await this.#withMutationLease(resource.id, async () => {
      // Resolved once for the whole scheduled reconciliation, recovery
      // included: deriveParams is user code and need not be deterministic, so
      // a second resolution could decide against one set of params and
      // persist another, with nothing to reconcile the two afterwards.
      const params = (await resource.getParams()) as Record<string, unknown>;

      await this.#retryOnRevConflict((conflict) =>
        this.#deployResourceOnce(
          resource,
          params,
          dryRun,
          driftDetection,
          conflict,
        ),
      );
    });
  }

  async #withMutationLease<T>(resourceId: string, fn: () => Promise<T>) {
    return this.#withLease(`reconciler:resource:${resourceId}`, fn);
  }

  async #withLease<T>(scope: string, fn: () => Promise<T>): Promise<T> {
    const lease = await this.#state.lease(scope, this.#mutationLeaseTtl);
    const controller = new AbortController();
    let renewalError: unknown;
    const heartbeat = (async () => {
      try {
        while (!controller.signal.aborted) {
          await sleep(
            Math.max(1, Math.floor(this.#mutationLeaseTtl / 3)),
            undefined,
            {
              signal: controller.signal,
            },
          );
          await lease.renew(this.#mutationLeaseTtl);
        }
      } catch (error) {
        if (!controller.signal.aborted) renewalError = error;
      }
    })();

    try {
      const result = await fn();
      if (renewalError) throw renewalError;
      return result;
    } finally {
      controller.abort();
      await heartbeat;
      await lease.release();
    }
  }

  async #retryOnRevConflict(fn: (conflict?: RevConflict) => Promise<void>) {
    let conflict: RevConflict | undefined;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await fn(conflict);
        return;
      } catch (error) {
        if (!(error instanceof RevConflict) || attempt === 2) throw error;
        // Re-throwing the conflict supplied for recovery means the resource
        // cannot be recovered safely (for example, it has no read operation).
        if (error === conflict) throw error;
        conflict = error;
      }
    }
  }

  async #deployResourceOnce(
    resource: BaseResource,
    params: Record<string, unknown>,
    dryRun: boolean,
    driftDetection: boolean,
    conflict?: RevConflict,
  ) {
    if (conflict) {
      await this.#recoverDeployResource(resource, params, dryRun, conflict);
      return;
    }

    const stateNode = await this.#state.get(resource.id);

    let action: ResourceAction;
    if (!stateNode) {
      action = decideAction({ resource, params });
    } else {
      resource.setOutput(stateNode.output);
      action = decideAction({ resource, stateNode, params });

      if (action.decision === "noop" && driftDetection) {
        const driftRead = await this.#readForDrift(
          resource,
          params,
          stateNode.output,
        );
        action = decideAction({ resource, stateNode, params, driftRead });
      }
    }

    if (action.decision === "drift-update") {
      await this.#emit?.({
        level: "info",
        event: "reconciler.drift.detected",
        resourceId: resource.id,
        resourceType: resource.type,
        diff: action.patch,
      });
    }

    await this.#emit?.({
      level: "info",
      event: "reconciler.deploy.decision",
      resourceId: resource.id,
      resourceType: resource.type,
      decision: action.decision,
    });

    switch (action.decision) {
      case "create":
      case "drift-recreate":
        await runOperation(
          createResourceOperation(this.#stepRunner, {
            resource,
            resourceParams: params,
            persistedOutput: stateNode?.output,
            dryRun,
            emit: this.#emitStep,
            maxOperationAttempts: this.#maxOperationAttempts,
            persist: this.#persist(resource.id, stateNode?.rev ?? 0),
          }),
        );
        return;
      case "update":
      case "drift-update":
        // decideAction only returns update decisions for an existing stateNode
        await runOperation(
          updateResourceOperation(this.#stepRunner, {
            resource,
            resourceParams: params,
            persistedOutput: stateNode?.output,
            patch: action.patch,
            dryRun,
            emit: this.#emitStep,
            maxOperationAttempts: this.#maxOperationAttempts,
            persist: this.#persist(resource.id, stateNode!.rev),
          }),
        );
        return;
      case "noop":
        return;
    }
  }

  async #recoverDeployResource(
    resource: BaseResource,
    params: Record<string, unknown>,
    dryRun: boolean,
    conflict: RevConflict,
  ) {
    if (!resource.read) throw conflict;

    const stateNode = await this.#state.get(resource.id);
    if (stateNode) resource.setOutput(stateNode.output);

    const remote = await this.#readForDrift(
      resource,
      params,
      stateNode?.output,
    );
    const action = decideAction({
      resource,
      stateNode,
      params,
      driftRead: remote,
    });
    if (remote.kind === "present") resource.setOutput(remote.output);

    // Recovery is drift adoption: the remote moved while the attempt that
    // conflicted was in flight, so the same event a first-pass drift-update
    // emits is owed here too.
    if (action.decision === "drift-update") {
      await this.#emit?.({
        level: "info",
        event: "reconciler.drift.detected",
        resourceId: resource.id,
        resourceType: resource.type,
        diff: action.patch,
      });
    }

    await this.#emit?.({
      level: "info",
      event: "reconciler.deploy.decision",
      resourceId: resource.id,
      resourceType: resource.type,
      decision: action.decision,
    });

    switch (action.decision) {
      case "create":
      case "drift-recreate":
        await runOperation(
          createResourceOperation(this.#stepRunner, {
            resource,
            resourceParams: params,
            persistedOutput: stateNode?.output,
            dryRun,
            emit: this.#emitStep,
            maxOperationAttempts: this.#maxOperationAttempts,
            persist: this.#persist(resource.id, stateNode?.rev ?? 0),
          }),
        );
        return;
      case "update":
      case "drift-update":
        await runOperation(
          updateResourceOperation(this.#stepRunner, {
            resource,
            resourceParams: params,
            persistedOutput: stateNode?.output,
            patch: action.patch,
            dryRun,
            emit: this.#emitStep,
            maxOperationAttempts: this.#maxOperationAttempts,
            persist: this.#persist(resource.id, stateNode?.rev ?? 0),
          }),
        );
        return;
      case "noop":
        if (dryRun) return;
        await this.#state.update(resource.id, stateNode?.rev ?? 0, {
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
        return;
    }
  }

  // In process, concurrency control is a compare-and-set against the revision
  // read before the operation started; the mutation lease keeps writers apart.
  #persist(resourceId: string, expectedRev: number): PersistState {
    const state = this.#state;
    return async function* (next) {
      await state.update(resourceId, expectedRev, next);
    };
  }

  #remove(resourceId: string, expectedRev: number): RemoveState {
    const state = this.#state;
    return async function* () {
      await state.delete(resourceId, expectedRev);
    };
  }

  #readForDrift(
    resource: BaseResource,
    params: Record<string, unknown>,
    persistedOutput: Record<string, unknown> | undefined,
  ): Promise<DriftRead> {
    return runOperation(
      readDriftOperation(this.#stepRunner, {
        resource,
        resourceParams: params,
        persistedOutput,
        emit: this.#emitStep,
        maxOperationAttempts: this.#maxOperationAttempts,
      }),
    );
  }

  async #deleteOrphans(
    resources: BaseResource[],
    resourceById: Map<string, BaseResource>,
    dryRun: boolean,
    workflow: "deploy" | "refresh",
  ) {
    await this.#withLease("reconciler:orphan-deletion", async () => {
      const stateNodes = await this.#state.values();
      const registry =
        this.#registry ?? createResourceRegistryFromResources(resources);

      for (const stateNode of stateNodes) {
        if (resourceById.has(stateNode.id)) continue;

        const stateNodeResourceType = stateNode.type as ResourceType;

        const Resource = resolveResourceClass(registry, stateNodeResourceType);
        if (!Resource) {
          await this.#emit?.(
            createMissingResourceRegistryMatchWarningEvent({
              workflow,
              resourceId: stateNode.id,
              resourceType: stateNodeResourceType,
            }),
          );
          continue;
        }

        await this.#withMutationLease(stateNode.id, () =>
          this.#retryOnRevConflict(async (conflict) => {
            const currentNode = await this.#state.get(stateNode.id);
            if (!currentNode) return;

            const orphanResource = hydrateResourceFromState(
              Resource,
              currentNode,
            );

            await this.#deleteResourceOnce(
              orphanResource,
              currentNode,
              dryRun,
              conflict,
            );
          }),
        );
      }
    });
  }

  async #destroyResource(resource: BaseResource, dryRun: boolean) {
    await this.#withMutationLease(resource.id, () =>
      this.#retryOnRevConflict(async (conflict) => {
        const stateNode = await this.#state.get(resource.id);
        if (!stateNode) {
          return;
        }

        resource.setOutput(stateNode.output);
        await this.#deleteResourceOnce(resource, stateNode, dryRun, conflict);
      }),
    );
  }

  async #deleteResourceOnce(
    resource: BaseResource,
    stateNode: StateNode,
    dryRun: boolean,
    conflict?: RevConflict,
  ) {
    if (conflict) {
      if (!resource.read) throw conflict;

      // Deletion never needs the desired params, so they are resolved here
      // rather than for every delete: only the recovery read consumes them.
      const params = (await resource.getParams()) as Record<string, unknown>;
      const remote = await this.#readForDrift(
        resource,
        params,
        stateNode.output,
      );
      if (remote.kind !== "present") {
        if (!dryRun) await this.#state.delete(resource.id, stateNode.rev);
        return;
      }
      resource.setOutput(remote.output);
    }

    await runOperation(
      deleteResourceOperation(this.#stepRunner, {
        resource,
        dryRun,
        emit: this.#emitStep,
        maxOperationAttempts: this.#maxOperationAttempts,
        remove: this.#remove(resource.id, stateNode.rev),
      }),
    );
  }
}

function hydrateResourceFromState(
  Resource: new (opts: {
    id: string;
    config: Record<string, unknown>;
  }) => BaseResource,
  stateNode: StateNode,
): BaseResource {
  const resource = new Resource({
    id: stateNode.id,
    config: stateNode.config,
  });
  resource.setOutput(stateNode.output);
  return resource;
}
