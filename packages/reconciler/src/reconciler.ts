import type { BaseResource, ResourceType } from "@notation/resource";
import { RevConflict, type State, type StateNode } from "@notation/state";
import { RetryableError } from "yieldstar";
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
  matchError,
  readResourceOperation,
  type OperationLifecycleEvent,
  type PollOptions,
  type StepRunner,
  updateResourceOperation,
} from "./operations";
import {
  createMissingResourceRegistryMatchWarningEvent,
  createResourceRegistryFromResources,
  resolveResourceClass,
  type MissingResourceRegistryMatchWarningEvent,
  type ResourceRegistry,
} from "./resource-registry";

export type ReconcilerDeployEvent = {
  level: "info";
  event: "reconciler.deploy.decision";
  resourceId: string;
  resourceType: string;
  decision: "create" | "update" | "drift-update" | "drift-recreate" | "noop";
};

export type ReconcilerDriftDetectedEvent = {
  level: "info";
  event: "reconciler.drift.detected";
  resourceId: string;
  resourceType: string;
  diff: Record<string, unknown>;
};

export type ReconcilerEvent =
  | OperationLifecycleEvent
  | ReconcilerDeployEvent
  | ReconcilerDriftDetectedEvent
  | MissingResourceRegistryMatchWarningEvent;

export type ReconcilerEventEmitter = (
  event: ReconcilerEvent,
) => void | Promise<void>;

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
  retryOptions?: PollOptions;
  readPollOptions?: PollOptions;
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
  readonly #retryOptions?: PollOptions;
  readonly #readPollOptions?: PollOptions;
  readonly #mutationLeaseTtl: number;
  readonly #stepRunner: StepRunner;

  constructor(opts: ReconcilerOptions) {
    this.#state = opts.state;
    this.#registry = opts.registry;
    this.#defaultDryRun = opts.dryRun ?? false;
    this.#defaultDriftDetection = opts.driftDetection ?? true;
    this.#emit = opts.emit;
    this.#retryOptions = opts.retryOptions;
    this.#readPollOptions = opts.readPollOptions;
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
    const driftDetection = opts.driftDetection ?? this.#defaultDriftDetection;
    const resourceById = new Map(
      resources.map((resource) => [resource.id, resource]),
    );
    const nodes: PlanNode[] = [];

    const dependencyLevels = buildResourceDepthLevels(resources);
    for (const level of dependencyLevels) {
      for (const resource of level) {
        nodes.push(await this.#planResource(resource, driftDetection));
      }
    }

    const stateNodes = await this.#state.values();
    for (const stateNode of stateNodes) {
      if (resourceById.has(stateNode.id)) continue;

      nodes.push({
        id: stateNode.id,
        type: stateNode.type,
        decision: "delete-orphan",
        params: stateNode.params,
        dependsOn: [],
      });
    }

    return {
      createdAt: new Date().toISOString(),
      nodes,
    };
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
    await this.#withMutationLease(resource.id, () =>
      this.#retryOnRevConflict((conflict) =>
        this.#deployResourceOnce(resource, dryRun, driftDetection, conflict),
      ),
    );
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
    dryRun: boolean,
    driftDetection: boolean,
    conflict?: RevConflict,
  ) {
    if (conflict) {
      await this.#recoverDeployResource(resource, dryRun, conflict);
      return;
    }

    const stateNode = await this.#state.get(resource.id);

    let action: ResourceAction;
    if (!stateNode) {
      action = decideAction({ resource });
    } else {
      resource.setOutput(stateNode.output);
      const params = await resource.getParams();
      action = decideAction({ resource, stateNode, params });

      if (action.decision === "noop" && driftDetection) {
        const driftRead = await this.#readForDrift(resource);
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
            state: this.#state,
            dryRun,
            emit: this.#emit,
            retryOptions: this.#retryOptions,
            readPollOptions: this.#readPollOptions,
            expectedRev: stateNode?.rev ?? 0,
          }),
        );
        return;
      case "update":
      case "drift-update":
        // decideAction only returns update decisions for an existing stateNode
        await runOperation(
          updateResourceOperation(this.#stepRunner, {
            resource,
            state: this.#state,
            patch: action.patch,
            dryRun,
            emit: this.#emit,
            retryOptions: this.#retryOptions,
            readPollOptions: this.#readPollOptions,
            expectedRev: stateNode!.rev,
          }),
        );
        return;
      case "noop":
        return;
    }
  }

  async #recoverDeployResource(
    resource: BaseResource,
    dryRun: boolean,
    conflict: RevConflict,
  ) {
    if (!resource.read) throw conflict;

    const stateNode = await this.#state.get(resource.id);
    if (stateNode) resource.setOutput(stateNode.output);

    const params = await resource.getParams();
    const remote = await this.#readForDrift(resource);
    const action = decideAction({
      resource,
      stateNode,
      params,
      driftRead: remote,
    });
    if (remote.status === "found") resource.setOutput(remote.output);

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
            state: this.#state,
            dryRun,
            emit: this.#emit,
            retryOptions: this.#retryOptions,
            readPollOptions: this.#readPollOptions,
            expectedRev: stateNode?.rev ?? 0,
          }),
        );
        return;
      case "update":
      case "drift-update":
        await runOperation(
          updateResourceOperation(this.#stepRunner, {
            resource,
            state: this.#state,
            patch: action.patch,
            dryRun,
            emit: this.#emit,
            retryOptions: this.#retryOptions,
            readPollOptions: this.#readPollOptions,
            expectedRev: stateNode?.rev ?? 0,
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

  async #planResource(
    resource: BaseResource,
    driftDetection: boolean,
  ): Promise<PlanNode> {
    const stateNode = await this.#state.get(resource.id);
    if (stateNode) {
      resource.setOutput(stateNode.output);
    }

    const params = await resolvePlanParams(resource);
    let action = decideAction({ resource, stateNode, params });

    if (action.decision === "noop" && driftDetection) {
      const driftRead = await this.#readForDrift(resource);
      action = decideAction({ resource, stateNode, params, driftRead });
    }

    return {
      id: resource.id,
      type: resource.type,
      decision: action.decision,
      ...("diff" in action ? { diff: action.diff } : {}),
      params,
      dependsOn: getDependencyIds(resource),
    };
  }

  async #readForDrift(resource: BaseResource): Promise<DriftRead> {
    try {
      const output = await runOperation(
        readResourceOperation(this.#stepRunner, {
          resource,
          state: this.#state,
          emit: this.#emit,
          readPollOptions: this.#readPollOptions,
        }),
      );
      return { status: "found", output };
    } catch (err) {
      const matcher = matchError(err, resource.notFoundOnError);
      if (!matcher) throw err;
      return { status: "not-found" };
    }
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

      const remote = await this.#readForDrift(resource);
      if (remote.status === "not-found") {
        if (!dryRun) await this.#state.delete(resource.id, stateNode.rev);
        return;
      }
      resource.setOutput(remote.output);
    }

    await runOperation(
      deleteResourceOperation(this.#stepRunner, {
        resource,
        state: this.#state,
        dryRun,
        emit: this.#emit,
        retryOptions: this.#retryOptions,
        expectedRev: stateNode.rev,
      }),
    );
  }
}

export async function runOperation<T>(
  operation: AsyncGenerator<unknown, T, unknown>,
) {
  let next = await operation.next();
  while (!next.done) {
    next = await operation.next();
  }
  return next.value;
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

export function createStepRunner(): StepRunner {
  return {
    async *run<T>(
      arg1: string | (() => T | Promise<T>),
      arg2?: () => T | Promise<T>,
    ): AsyncGenerator<unknown, T, unknown> {
      const fn = (typeof arg1 === "string" ? arg2 : arg1) as
        (() => T | Promise<T>) | undefined;

      if (!fn) {
        throw new Error("Missing run function");
      }

      while (true) {
        try {
          return await fn();
        } catch (err) {
          if (!(err instanceof RetryableError)) {
            throw err;
          }
        }
      }
    },
    async *poll(
      arg1: string | PollOptions,
      arg2: PollOptions | (() => boolean | Promise<boolean>),
      arg3?: () => boolean | Promise<boolean>,
    ): AsyncGenerator<unknown, void, unknown> {
      const opts = (typeof arg1 === "string" ? arg2 : arg1) as PollOptions;
      const predicate = (typeof arg1 === "string" ? arg3 : arg2) as
        (() => boolean | Promise<boolean>) | undefined;

      if (!predicate) {
        throw new Error("Missing poll predicate");
      }

      for (let attempt = 0; attempt < opts.maxAttempts; attempt += 1) {
        if (await predicate()) return;
      }

      throw new RetryableError("Polling reached max retries", {
        maxAttempts: opts.maxAttempts,
        retryInterval: opts.retryInterval,
      });
    },
    async *delay(
      arg1: string | number,
      arg2?: number,
    ): AsyncGenerator<unknown, void, unknown> {
      const ms = typeof arg1 === "number" ? arg1 : arg2;
      if (ms === undefined) {
        throw new Error("Missing delay duration");
      }

      await new Promise((resolve) => setTimeout(resolve, ms));
    },
  };
}
