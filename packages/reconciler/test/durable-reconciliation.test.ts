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
import {
  resource,
  ResourceNotFoundError,
  ResourceOperationPendingError,
  type BaseResource,
} from "@notation/resource";
import { setTimeout as sleep } from "node:timers/promises";
import pino from "pino";
import { createWorkflowRouter, workflow } from "yieldstar";
import { describe, expect, it, vi } from "vitest";
import * as durable from "../src/durable";
import type { ReconcilerEvent } from "../src/events";
import {
  createResourceRegistry,
  type ResourceRegistry,
} from "../src/resource-registry";

const logger = pino({ level: "silent" });

/**
 * A retry delay has to outlive the heap write that follows it. The workflow
 * loop continues inline for a delay that has already elapsed by the time it
 * is reached, so a delay shorter than a SQLite write runs the retry in the
 * same execution — which is the opposite of what these tests assert.
 */
const RETRY_AFTER_MS = 50;
const PAST_RETRY_MS = RETRY_AFTER_MS + 25;

describe("durable execution and replay", () => {
  it("waits durably for a retryable provider and persists after success", async () => {
    let attempts = 0;
    const PendingResource = resource({ type: "test/durable/pending" })
      .defineSchema({})
      .defineOperations({
        create: async (_params, context) => {
          attempts += 1;
          if (attempts === 1) {
            expect(context).toBeUndefined();
            throw new ResourceOperationPendingError("provider is not ready", {
              retryAfterMs: RETRY_AFTER_MS,
              callbackContext: { requestId: "request-123" },
            });
          }
          expect(context).toEqual({ requestId: "request-123" });
        },
        delete: async () => undefined,
      });
    const runtime = createRuntime(
      [new PendingResource({ id: "pending" })],
      "durable-wait",
      { maxOperationAttempts: 3 },
    );

    await runtime.run("wait-execution");
    expect(attempts).toBe(1);
    expect(runtime.scheduler.events).toHaveLength(1);

    await sleep(PAST_RETRY_MS);
    await runtime.run("wait-execution");
    expect(attempts).toBe(2);
    expect(await runtime.state.get("pending")).toMatchObject({
      id: "pending",
      lastOperation: "create",
      rev: 1,
    });
    runtime.close();
  });

  it("resumes after a crash following the create checkpoint", async () => {
    const create = vi.fn(async () => undefined);
    const TestResource = resource({ type: "test/durable/resume" })
      .defineSchema({})
      .defineOperations({ create, delete: async () => undefined });
    const runtime = createRuntime(
      [new TestResource({ id: "resume" })],
      "crash-resume",
      { crashAfterStep: "notation:resource:resume:create:remote:attempt:0" },
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

  it("resumes after a crash following the delete checkpoint", async () => {
    const remove = vi.fn(async () => undefined);
    const TestResource = resource({ type: "test/durable/destroy-resume" })
      .defineSchema({})
      .defineOperations({ create: async () => undefined, delete: remove });
    const runtime = createRuntime(
      [new TestResource({ id: "destroyed" })],
      "destroy-crash-resume",
      { crashAfterStep: "notation:destroy:destroyed:delete:remote:attempt:0" },
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
    const PendingDelete = resource({ type: "test/durable/pending-delete" })
      .defineSchema({})
      .defineOperations({
        create: async () => undefined,
        delete: async () => {
          attempts += 1;
          if (attempts === 1) {
            throw new ResourceOperationPendingError("delete is not ready", {
              retryAfterMs: RETRY_AFTER_MS,
            });
          }
        },
      });
    const runtime = createRuntime(
      [new PendingDelete({ id: "pending-delete" })],
      "durable-destroy-wait",
      { maxOperationAttempts: 3 },
    );

    await runtime.run("deploy-before-wait");
    await runtime.destroy("destroy-wait");
    expect(attempts).toBe(1);
    expect(await runtime.state.get("pending-delete")).toBeDefined();

    await sleep(PAST_RETRY_MS);
    await runtime.destroy("destroy-wait");
    expect(attempts).toBe(2);
    expect(await runtime.state.get("pending-delete")).toBeUndefined();
    runtime.close();
  });

  it("waits when a resource reports that its post-write read is pending", async () => {
    let reads = 0;
    const EventuallyReadable = resource({
      type: "test/durable/eventually-readable",
    })
      .defineSchema({})
      .defineOperations({
        create: async () => undefined,
        read: async () => {
          reads += 1;
          if (reads === 1) {
            throw new ResourceOperationPendingError(
              "resource is not visible yet",
              { retryAfterMs: RETRY_AFTER_MS },
            );
          }
          return {} as const;
        },
        delete: async () => undefined,
      });
    const runtime = createRuntime(
      [new EventuallyReadable({ id: "eventually-readable" })],
      "post-write-read",
      { maxOperationAttempts: 3 },
    );

    await runtime.run("post-write-read-execution");
    expect(reads).toBe(1);
    expect(await runtime.state.get("eventually-readable")).toBeUndefined();

    await sleep(PAST_RETRY_MS);
    await runtime.run("post-write-read-execution");
    expect(reads).toBe(2);
    expect(await runtime.state.get("eventually-readable")).toMatchObject({
      rev: 1,
    });
    runtime.close();
  });

  it("does not infer that not-found after a write is pending", async () => {
    const MissingAfterCreate = resource({
      type: "test/durable/missing-after-create",
    })
      .defineSchema({})
      .defineOperations({
        create: async () => undefined,
        read: async () => {
          throw new ResourceNotFoundError("resource is absent");
        },
        delete: async () => undefined,
      });
    const runtime = createRuntime(
      [new MissingAfterCreate({ id: "missing-after-create" })],
      "missing-after-create",
    );

    await expect(runtime.run("missing-after-create-execution")).rejects.toThrow(
      "resource is absent",
    );
    expect(await runtime.state.get("missing-after-create")).toBeUndefined();
    runtime.close();
  });
});

describe("dependency ordering", () => {
  it("destroys dependents before their dependencies", async () => {
    const order: string[] = [];
    const Dependency = resource({ type: "test/durable/dependency" })
      .defineSchema({})
      .defineOperations({
        create: async () => undefined,
        delete: async () => void order.push("dependency"),
      });
    const Dependent = resource({ type: "test/durable/dependent" })
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
});

describe("conditional state persistence", () => {
  it("rejects a state write whose snapshot another writer has moved past", async () => {
    const RaceResource = resource({ type: "test/durable/write-race" })
      // Cast: a resource declared without API types constrains every schema
      // key to be a key of an `any` API schema, which no named key satisfies.
      .defineSchema({
        name: { presence: "required", propertyType: "param" },
      } as any)
      .defineOperations({
        create: async () => undefined,
        // Moves the store on between the workflow reading its snapshot and
        // persisting against it, which is what the conditional write guards.
        update: async () => {
          await runtime.storeClient.updateStore({
            definition: durable.resourceStateStore,
            id: runtime.state.storeId("raced"),
            updater: (draft: any) => {
              draft.lastOperationAt = "1999-01-01T00:00:00.000Z";
            },
          });
        },
        delete: async () => undefined,
      });
    const resources = [
      new RaceResource({ id: "raced", config: { name: "before" } }),
    ];
    const runtime = createRuntime(resources, "write-race");

    await runtime.run("deploy-1");
    resources[0] = new RaceResource({ id: "raced", config: { name: "after" } });

    await expect(runtime.run("deploy-2")).rejects.toMatchObject({
      name: "RevConflict",
    });
    // The losing write left the other writer's record intact.
    expect(await runtime.state.get("raced")).toMatchObject({
      rev: 2,
      lastOperationAt: "1999-01-01T00:00:00.000Z",
    });
    runtime.close();
  });

  it("rejects a state removal whose snapshot another writer has moved past", async () => {
    const RaceResource = resource({ type: "test/durable/delete-race" })
      .defineSchema({})
      .defineOperations({
        create: async () => undefined,
        delete: async () => {
          await runtime.storeClient.updateStore({
            definition: durable.resourceStateStore,
            id: runtime.state.storeId("delete-raced"),
            updater: (draft: any) => {
              draft.lastOperationAt = "1999-01-01T00:00:00.000Z";
            },
          });
        },
      });
    const runtime = createRuntime(
      [new RaceResource({ id: "delete-raced" })],
      "delete-race",
    );

    await runtime.run("deploy-1");
    await expect(runtime.destroy("destroy-1")).rejects.toMatchObject({
      name: "RevConflict",
    });
    // State survives a removal that could not be proven safe.
    expect(await runtime.state.get("delete-raced")).toBeDefined();
    runtime.close();
  });
});

describe("deployment coordination", () => {
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
    const TestResource = resource({ type: "test/durable/concurrent" })
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

  it("still holds the deployment when a failed execution is resumed", async () => {
    // The failure has to live in plain generator code. A step that fails
    // caches a StepError, and a cached StepError is rethrown on replay before
    // the step's function is reached, so no later work would ever run
    // uncached. decideAction calls toComparable outside any step, after the
    // resource's reads have been checkpointed.
    let failBeforeSecond = true;
    const holders: Array<string | null> = [];
    const Resource = resource({ type: "test/durable/hold-replay" })
      .defineSchema({})
      .defineOperations({
        create: async () => {
          const snapshot = await runtime.storeClient.getStore({
            definition: durable.deploymentCoordinationStore,
            id: "hold-replay",
          });
          holders.push(snapshot.state.holder);
        },
        delete: async () => undefined,
      });

    const first = new Resource({ id: "first" });
    const second = new Resource({ id: "second" });
    const toComparable = second.toComparable.bind(second);
    second.toComparable = (output) => {
      if (failBeforeSecond) throw new Error("simulated mid-deployment failure");
      return toComparable(output);
    };
    const runtime = createRuntime([first, second], "hold-replay");

    await expect(runtime.run("replayed-execution")).rejects.toThrow(
      "simulated mid-deployment failure",
    );
    expect(holders).toEqual(["replayed-execution"]);

    failBeforeSecond = false;
    await runtime.run("replayed-execution");

    // The second resource's create is the first uncached work after the
    // failure, so it observes whichever hold the resumed execution is running
    // under. Releasing on the way out of a failure would leave it null here.
    expect(holders).toEqual(["replayed-execution", "replayed-execution"]);
    runtime.close();
  });

  it("emits a coordination waiting event when another execution holds the deployment", async () => {
    let unblockCreate!: () => void;
    const blocked = new Promise<void>((resolve) => {
      unblockCreate = resolve;
    });
    let started!: () => void;
    const createStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const TestResource = resource({ type: "test/durable/coordination" })
      .defineSchema({})
      .defineOperations({
        create: async () => {
          started();
          await blocked;
        },
        delete: async () => undefined,
      });
    const events: ReconcilerEvent[] = [];
    const runtime = createRuntime(
      [new TestResource({ id: "held" })],
      "coordination-waiting",
      { emit: (event) => void events.push(event) },
    );

    const first = runtime.run("holder-execution");
    await createStarted;
    await runtime.run("waiter-execution");

    expect(
      events.find((event) => event.event === "reconciler.coordination.waiting"),
    ).toMatchObject({
      level: "warn",
      deploymentId: "coordination-waiting",
      executionId: "waiter-execution",
      holderExecutionId: "holder-execution",
    });

    unblockCreate();
    await first;
    runtime.close();
  });
});

describe("deployment scoping", () => {
  it("scopes store listing to the exact deployment despite prefix-like IDs", async () => {
    const database = createSqliteDb({ path: ":memory:" });
    const storeClient = new SqliteStoreClient({
      db: database,
      schedulerClient: new TestScheduler(),
    });
    const app = new durable.DurableStateBackend(storeClient, "app");
    const appBlue = new durable.DurableStateBackend(storeClient, "app:blue");

    await seedResourceState(storeClient, app.storeId("site"), "site");
    await seedResourceState(storeClient, appBlue.storeId("site"), "blue-site");

    // A deployment named "app:blue" falls inside a naive "app:" prefix scan;
    // encoding the deployment id is what keeps the two listings disjoint.
    expect((await app.values()).map((node) => node.id)).toEqual(["site"]);
    expect((await appBlue.values()).map((node) => node.id)).toEqual([
      "blue-site",
    ]);
    expect(await app.get("site")).toMatchObject({ id: "site" });
    expect(await appBlue.get("site")).toMatchObject({ id: "blue-site" });
    database.close();
  });
});

describe("orphan deletion", () => {
  it("deletes orphaned resources through the registry on a later deployment", async () => {
    const deleteSpy = vi.fn(async () => undefined);
    const OrphanResource = resource({ type: "test/durable/orphan" })
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
});

describe("drift detection and repair", () => {
  it("emits drift detection and repairs remote drift with update", async () => {
    let remote = { name: "expected" };
    const updateSpy = vi.fn(async () => {
      remote = { name: "expected" };
    });
    const DriftResource = resource({ type: "test/durable/drift" })
      // Cast: a resource declared without API types constrains every schema
      // key to be a key of an `any` API schema, which no named key satisfies.
      .defineSchema({
        name: { presence: "required", propertyType: "param" },
      } as any)
      .defineOperations({
        create: (async () => remote) as any,
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
    maxOperationAttempts?: number;
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
  const state = new durable.DurableStateBackend(storeClient, deploymentId);
  const deploy = workflow(async function* (step, event) {
    yield* durable.deploy(step, {
      deploymentId,
      executionId: event.executionId,
      resources,
      state,
      registry: options.registry,
      driftDetection: options.driftDetection ?? false,
      emit: options.emit,
      maxOperationAttempts: options.maxOperationAttempts,
    });
  });
  const destroy = workflow(async function* (step, event) {
    yield* durable.destroy(step, {
      deploymentId,
      executionId: event.executionId,
      resources,
      state,
      registry: options.registry,
      emit: options.emit,
      maxOperationAttempts: options.maxOperationAttempts,
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

function seedResourceState(
  storeClient: SqliteStoreClient,
  storeId: string,
  resourceId: string,
) {
  return storeClient.getOrCreateStore({
    definition: durable.resourceStateStore,
    id: storeId,
    initial: statePatch(resourceId),
  });
}

function statePatch(id: string) {
  return {
    id,
    type: "test/durable/state",
    groupId: -1,
    groupType: "",
    config: {},
    params: {},
    output: {},
    lastOperation: "create" as const,
    lastOperationAt: new Date().toISOString(),
  };
}
