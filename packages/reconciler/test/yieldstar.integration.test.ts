import {
  WorkflowRunner,
  type HeapClient,
  type WorkflowEvent,
} from "@yieldstar/core";
import {
  SqliteHeapClient,
  SqliteStoreClient,
  createSqliteDb,
} from "@yieldstar/sqlite-runtime/node";
import { resource, type BaseResource } from "@notation/resource";
import pino from "pino";
import { createWorkflowRouter, workflow } from "yieldstar";
import { describe, expect, it, vi } from "vitest";
import {
  YieldStarStateBackend,
  deployWithYieldStar,
  destroyWithYieldStar,
  yieldStarResourceStateStore,
} from "../src/yieldstar";
import type { ReconcilerEvent } from "../src/events";
import {
  createResourceRegistry,
  type ResourceRegistry,
} from "../src/resource-registry";

const logger = pino({ level: "silent" });

describe("YieldStar reconciliation", () => {
  it("waits durably for a retryable provider and persists after success", async () => {
    let attempts = 0;
    const PendingResource = resource({ type: "test/yieldstar/pending" })
      .defineSchema({})
      .defineOperations({
        create: async () => {
          attempts += 1;
          if (attempts === 1) {
            const error = new Error("provider is pending");
            error.name = "ProviderPending";
            throw error;
          }
        },
        delete: async () => undefined,
        retryLaterOnError: [
          { name: "ProviderPending", reason: "provider is pending" },
        ],
      });
    const runtime = createRuntime(
      [new PendingResource({ id: "pending" })],
      "durable-wait",
      { retryOptions: { maxAttempts: 3, retryInterval: 1 } },
    );

    await runtime.run("wait-execution");
    expect(attempts).toBe(1);
    expect(runtime.scheduler.events).toHaveLength(1);

    await runtime.run("wait-execution");
    expect(attempts).toBe(2);
    expect(await runtime.state.get("pending")).toMatchObject({
      id: "pending",
      lastOperation: "create",
      rev: 1,
    });
    runtime.close();
  });

  it("resumes after a crash without repeating a completed create", async () => {
    const create = vi.fn(async () => undefined);
    const TestResource = resource({ type: "test/yieldstar/resume" })
      .defineSchema({})
      .defineOperations({ create, delete: async () => undefined });
    const runtime = createRuntime(
      [new TestResource({ id: "resume" })],
      "crash-resume",
      { crashAfterStep: "notation:resource:resume:create" },
    );

    await expect(runtime.run("resume-execution")).rejects.toThrow(
      "simulated process crash",
    );
    expect(create).toHaveBeenCalledOnce();
    expect(await runtime.state.get("resume")).toBeUndefined();

    await runtime.run("resume-execution");
    expect(create).toHaveBeenCalledOnce();
    expect(await runtime.state.get("resume")).toMatchObject({ rev: 1 });
    runtime.close();
  });

  it("resumes durable destroy after a crash without repeating delete", async () => {
    const remove = vi.fn(async () => undefined);
    const TestResource = resource({ type: "test/yieldstar/destroy-resume" })
      .defineSchema({})
      .defineOperations({ create: async () => undefined, delete: remove });
    const runtime = createRuntime(
      [new TestResource({ id: "destroyed" })],
      "destroy-crash-resume",
      { crashAfterStep: "notation:destroy:destroyed:delete" },
    );

    await runtime.run("deploy-before-destroy");
    await expect(runtime.destroy("destroy-execution")).rejects.toThrow(
      "simulated process crash",
    );
    expect(remove).toHaveBeenCalledOnce();
    expect(await runtime.state.get("destroyed")).toBeDefined();

    await runtime.destroy("destroy-execution");
    expect(remove).toHaveBeenCalledOnce();
    expect(await runtime.state.get("destroyed")).toBeUndefined();
    runtime.close();
  });

  it("waits durably for a retryable delete before removing state", async () => {
    let attempts = 0;
    const PendingDelete = resource({ type: "test/yieldstar/pending-delete" })
      .defineSchema({})
      .defineOperations({
        create: async () => undefined,
        delete: async () => {
          attempts += 1;
          if (attempts === 1) {
            const error = new Error("delete is pending");
            error.name = "DeletePending";
            throw error;
          }
        },
        retryLaterOnError: [
          { name: "DeletePending", reason: "delete is pending" },
        ],
      });
    const runtime = createRuntime(
      [new PendingDelete({ id: "pending-delete" })],
      "durable-destroy-wait",
      { retryOptions: { maxAttempts: 3, retryInterval: 1 } },
    );

    await runtime.run("deploy-before-wait");
    await runtime.destroy("destroy-wait");
    expect(attempts).toBe(1);
    expect(await runtime.state.get("pending-delete")).toBeDefined();

    await runtime.destroy("destroy-wait");
    expect(attempts).toBe(2);
    expect(await runtime.state.get("pending-delete")).toBeUndefined();
    runtime.close();
  });

  it("destroys dependents before their dependencies", async () => {
    const order: string[] = [];
    const Dependency = resource({ type: "test/yieldstar/dependency" })
      .defineSchema({})
      .defineOperations({
        create: async () => undefined,
        delete: async () => void order.push("dependency"),
      });
    const Dependent = resource({ type: "test/yieldstar/dependent" })
      .defineSchema({})
      .defineOperations({
        create: async () => undefined,
        delete: async () => void order.push("dependent"),
      });
    const dependency = new Dependency({ id: "dependency" });
    const dependent = new Dependent({
      id: "dependent",
      dependencies: { dependency },
    });
    const runtime = createRuntime([dependency, dependent], "destroy-order");

    await runtime.run("deploy-before-ordered-destroy");
    await runtime.destroy("ordered-destroy");

    expect(order).toEqual(["dependent", "dependency"]);
    runtime.close();
  });

  it("uses store identity and version for conditional update and delete", async () => {
    const runtime = createRuntime([], "conditional-state");
    await runtime.state.update("resource", 0, statePatch("resource"));
    const originalSnapshot = await runtime.state.snapshot("resource");

    const first = runtime.state.update("resource", 1, {
      output: { winner: "first" },
    });
    const second = runtime.state.update("resource", 1, {
      output: { winner: "second" },
    });
    const results = await Promise.allSettled([first, second]);

    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    await expect(runtime.state.delete("resource", 1)).rejects.toMatchObject({
      name: "RevConflict",
    });
    expect(await runtime.state.get("resource")).toMatchObject({ rev: 2 });

    await runtime.state.clear();
    await runtime.state.update("resource", 0, statePatch("resource"));
    const staleDelete = await runtime.storeClient.deleteStoreFrom({
      definition: yieldStarResourceStateStore,
      id: runtime.state.storeId("resource"),
      snapshot: originalSnapshot,
    });
    expect(staleDelete).toMatchObject({
      deleted: false,
      reason: "conflict",
    });
    expect(await runtime.state.get("resource")).toMatchObject({ rev: 1 });
    runtime.close();
  });

  it("serializes concurrent deployments through durable store waiting", async () => {
    let unblockCreate!: () => void;
    const blocked = new Promise<void>((resolve) => {
      unblockCreate = resolve;
    });
    let started!: () => void;
    const createStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const create = vi.fn(async () => {
      started();
      await blocked;
    });
    const TestResource = resource({ type: "test/yieldstar/concurrent" })
      .defineSchema({})
      .defineOperations({ create, delete: async () => undefined });
    const runtime = createRuntime(
      [new TestResource({ id: "shared" })],
      "concurrent",
    );

    const first = runtime.run("deployment-a");
    await createStarted;
    await runtime.run("deployment-b");
    expect(create).toHaveBeenCalledOnce();

    unblockCreate();
    await first;
    const wake = runtime.scheduler.events.find(
      (event) => event.executionId === "deployment-b",
    );
    expect(wake).toBeDefined();
    await runtime.runner.run(wake!, logger);

    expect(create).toHaveBeenCalledOnce();
    expect(await runtime.state.values()).toHaveLength(1);
    runtime.close();
  });

  it("deletes orphaned resources through the registry on a later deployment", async () => {
    const deleteSpy = vi.fn(async () => undefined);
    const OrphanResource = resource({ type: "test/yieldstar/orphan" })
      .defineSchema({})
      .defineOperations({ create: async () => undefined, delete: deleteSpy });
    const resources: BaseResource[] = [new OrphanResource({ id: "orphan" })];
    const runtime = createRuntime(resources, "orphan-deletion", {
      registry: createResourceRegistry([OrphanResource]),
    });

    await runtime.run("deploy-1");
    expect(await runtime.state.values()).toHaveLength(1);

    resources.length = 0;
    await runtime.run("deploy-2");

    expect(deleteSpy).toHaveBeenCalledOnce();
    expect(await runtime.state.values()).toHaveLength(0);
    expect(await runtime.state.get("orphan")).toBeUndefined();
    runtime.close();
  });

  it("emits drift detection and repairs remote drift with update", async () => {
    let remote = { name: "expected" };
    const updateSpy = vi.fn(async () => {
      remote = { name: "expected" };
    });
    const DriftResource = resource({ type: "test/yieldstar/drift" })
      .defineSchema({
        name: {
          presence: "required",
          propertyType: "param",
          valueType: "string" as any,
        },
      })
      .defineOperations({
        create: async () => remote,
        read: async () => remote,
        update: updateSpy,
        delete: async () => undefined,
      });
    const events: ReconcilerEvent[] = [];
    const runtime = createRuntime(
      [new DriftResource({ id: "drifted", config: { name: "expected" } })],
      "drift-repair",
      { driftDetection: true, emit: (event) => void events.push(event) },
    );

    await runtime.run("deploy-1");
    remote = { name: "drifted" };
    await runtime.run("deploy-2");

    expect(updateSpy).toHaveBeenCalledOnce();
    expect(
      events.find((event) => event.event === "reconciler.drift.detected"),
    ).toMatchObject({ resourceId: "drifted", diff: { name: "expected" } });
    expect(
      events.filter(
        (event) =>
          event.event === "reconciler.deploy.decision" &&
          event.decision === "drift-update",
      ),
    ).toHaveLength(1);
    runtime.close();
  });
});

function createRuntime(
  resources: BaseResource[],
  deploymentId: string,
  options: {
    retryOptions?: { maxAttempts: number; retryInterval: number };
    crashAfterStep?: string;
    registry?: ResourceRegistry;
    driftDetection?: boolean;
    emit?: (event: ReconcilerEvent) => void;
  } = {},
) {
  const database = createSqliteDb({ path: ":memory:" });
  const scheduler = new TestScheduler();
  const sqliteHeap = new SqliteHeapClient(database);
  const heap = options.crashAfterStep
    ? new CrashAfterWriteHeap(sqliteHeap, options.crashAfterStep)
    : sqliteHeap;
  const storeClient = new SqliteStoreClient({
    db: database,
    schedulerClient: scheduler,
  });
  const state = new YieldStarStateBackend(storeClient, deploymentId);
  const deploy = workflow(async function* (step, event) {
    yield* deployWithYieldStar(step, {
      deploymentId,
      executionId: event.executionId,
      resources,
      state,
      registry: options.registry,
      driftDetection: options.driftDetection ?? false,
      emit: options.emit,
      retryOptions: options.retryOptions,
    });
  });
  const destroy = workflow(async function* (step, event) {
    yield* destroyWithYieldStar(step, {
      deploymentId,
      executionId: event.executionId,
      resources,
      state,
      registry: options.registry,
      emit: options.emit,
      retryOptions: options.retryOptions,
    });
  });
  const router = createWorkflowRouter({ deploy, destroy });
  const runner = new WorkflowRunner({
    router,
    heapClient: heap,
    storeClient,
    schedulerClient: scheduler,
    logger,
  });

  return {
    runner,
    scheduler,
    state,
    storeClient,
    run(executionId: string) {
      return runner.run(
        {
          workflowId: "deploy",
          executionId,
          params: {},
          context: new Map(),
        },
        logger,
      );
    },
    destroy(executionId: string) {
      return runner.run(
        {
          workflowId: "destroy",
          executionId,
          params: {},
          context: new Map(),
        },
        logger,
      );
    },
    close() {
      database.close();
    },
  };
}

class TestScheduler {
  readonly events: WorkflowEvent[] = [];

  async requestWakeUp(event: WorkflowEvent) {
    this.events.push(event);
  }
}

class CrashAfterWriteHeap implements HeapClient {
  #crashed = false;

  constructor(
    private readonly inner: HeapClient,
    private readonly crashAfterStep: string,
  ) {}

  readStep(params: { executionId: string; stepKey: string }) {
    return this.inner.readStep(params);
  }

  async writeStep(params: {
    executionId: string;
    stepKey: string;
    stepAttempt: number;
    stepDone: boolean;
    stepResponseJson: string;
  }) {
    await this.inner.writeStep(params);
    if (
      !this.#crashed &&
      params.stepKey === this.crashAfterStep &&
      params.stepDone
    ) {
      this.#crashed = true;
      throw new Error("simulated process crash");
    }
  }
}

function statePatch(id: string) {
  return {
    id,
    type: "test/yieldstar/state",
    config: {},
    params: {},
    output: {},
    lastOperation: "create" as const,
    lastOperationAt: new Date().toISOString(),
  };
}
