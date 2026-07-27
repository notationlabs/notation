import type { BaseResource, ResourceType } from "@notation/resource";
import { RevConflict, type State, type StateNode } from "@notation/state";
import { setTimeout as sleep } from "node:timers/promises";
import { buildResourceDepthLevels } from "./dependency-graph";
import type { Plan } from "./plan";
import type { PersistState, RemoveState, StepRunner } from "./operations";
import {
  destroyResource,
  reconcileResource,
  type EmitFromStep,
  type OpenStateSession,
} from "./reconcile";
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
  readonly #emitFromStep?: EmitFromStep;
  readonly #maxOperationAttempts?: number;
  readonly #mutationLeaseTtl: number;
  readonly #stepRunner: StepRunner;

  constructor(opts: ReconcilerOptions) {
    this.#state = opts.state;
    this.#registry = opts.registry;
    this.#defaultDryRun = opts.dryRun ?? false;
    this.#defaultDriftDetection = opts.driftDetection ?? true;
    this.#emit = opts.emit;
    // Everything the shared generator emits — decisions, drift and operation
    // lifecycle alike — goes through one seam; in process it is a plain
    // await, and the scope it is handed is ignored because nothing is keyed.
    this.#emitFromStep = opts.emit ? emitDirectly(opts.emit) : undefined;
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
    const resourceById = new Map(
      resources.map((resource) => [resource.id, resource]),
    );
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

    // Then the records that were never declared, so a destroy leaves the
    // deployment empty rather than leaving orphans for a later refresh.
    await this.#deleteOrphans(resources, resourceById, dryRun, "destroy");
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
        runOperation(
          reconcileResource(this.#stepRunner, {
            resource,
            resourceParams: params,
            openSession: this.#openSession(),
            emit: this.#emitFromStep,
            dryRun,
            driftDetection,
            maxOperationAttempts: this.#maxOperationAttempts,
            recoverFrom: conflict,
          }),
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

  /**
   * Reads a resource's record and binds the writes that are conditional on
   * that read. In process the precondition is the revision read here, which
   * the mutation lease keeps other writers away from.
   */
  #openSession(): OpenStateSession {
    const state = this.#state;
    return async function* (resource: BaseResource) {
      const node = await state.get(resource.id);
      const expectedRev = node?.rev ?? 0;
      const persist: PersistState = async function* (next) {
        await state.update(resource.id, expectedRev, next);
      };

      if (!node) return { node: undefined, persist };

      const remove: RemoveState = async function* () {
        await state.delete(resource.id, node.rev);
      };
      return { node, persist, remove };
    };
  }

  async #deleteOrphans(
    resources: BaseResource[],
    resourceById: Map<string, BaseResource>,
    dryRun: boolean,
    workflow: "deploy" | "refresh" | "destroy",
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

        // Built from the listing, so its config is as of that read rather
        // than of the lease taken below — the session re-reads and refreshes
        // output, but not this. Config reaches nothing but deriveParams on
        // the delete-recovery read, so a racing write can only make that read
        // one revision stale; the removal itself is still conditional on the
        // session's own read.
        const orphanResource = hydrateResourceFromState(Resource, stateNode);
        await this.#withMutationLease(stateNode.id, () =>
          this.#retryOnRevConflict((conflict) =>
            this.#deleteResource(orphanResource, dryRun, conflict),
          ),
        );
      }
    });
  }

  async #destroyResource(resource: BaseResource, dryRun: boolean) {
    await this.#withMutationLease(resource.id, () =>
      this.#retryOnRevConflict((conflict) =>
        this.#deleteResource(resource, dryRun, conflict),
      ),
    );
  }

  async #deleteResource(
    resource: BaseResource,
    dryRun: boolean,
    conflict?: RevConflict,
  ) {
    // Deletion never needs the desired params, so they are resolved only for
    // the recovery read, which is their sole consumer on this path.
    const recoverFrom = conflict
      ? {
          conflict,
          resourceParams: (await resource.getParams()) as Record<
            string,
            unknown
          >,
        }
      : undefined;

    await runOperation(
      destroyResource(this.#stepRunner, {
        resource,
        openSession: this.#openSession(),
        emit: this.#emitFromStep,
        dryRun,
        maxOperationAttempts: this.#maxOperationAttempts,
        recoverFrom,
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

/**
 * The in-process emit seam: a scope carries no meaning here, since nothing
 * keys anything, so every scope delivers through the same emitter.
 */
function emitDirectly(emit: ReconcilerEventEmitter): EmitFromStep {
  const step = toEmitStep(emit);
  return () => step;
}
