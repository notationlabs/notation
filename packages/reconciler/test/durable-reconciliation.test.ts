import {
  REDELIVERY_DELAY_BASE,
  WorkflowRunner,
  type EffectClient,
  type ExecutionLease,
  type HeapClient,
  type Runtime,
  type StoreClient,
} from "@yieldstar/core";
import { SqliteRuntime, createSqliteDb } from "@yieldstar/sqlite-runtime/node";
import {
  resource,
  ResourceNotFoundError,
  ResourceOperationPendingError,
  type BaseResource,
  type ResourceType,
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
      [new PendingResource("pending")],
      "durable-wait",
      { maxOperationAttempts: 3 },
    );

    await expect(runtime.run("wait-execution")).resolves.toMatchObject({
      status: "suspended",
      wakeAt: expect.any(Number),
    });
    expect(attempts).toBe(1);

    await sleep(PAST_RETRY_MS);
    await runtime.run("wait-execution");
    expect(attempts).toBe(2);
    expect(await runtime.state.get("pending")).toMatchObject({
      id: "pending",
      lastOperation: "create",
      version: 1,
    });
    runtime.close();
  });

  it("resumes after a crash following the create checkpoint", async () => {
    const create = vi.fn(async () => undefined);
    const TestResource = resource({ type: "test/durable/resume" })
      .defineSchema({})
      .defineOperations({ create, delete: async () => undefined });
    const runtime = createRuntime(
      [new TestResource("resume")],
      "crash-resume",
      { crashAfterStep: "notation:deploy:resume:create:remote:effect:0" },
    );

    await expect(runtime.run("resume-execution")).rejects.toThrow(
      "simulated process crash",
    );
    expect(create).toHaveBeenCalledOnce();
    expect(await runtime.state.get("resume")).toBeUndefined();

    await runtime.run("resume-execution");
    expect(create).toHaveBeenCalledOnce();
    expect(await runtime.state.get("resume")).toMatchObject({ version: 1 });
    runtime.close();
  });

  it("reads a create interrupted before its outcome was recorded instead of creating again", async () => {
    const create = vi.fn(async () => undefined);
    const read = vi.fn(async () => ({ name: "app" }));
    const TestResource = resource({ type: "test/durable/effect-read" })
      // Cast: a resource declared without API types constrains every schema
      // key to be a key of an `any` API schema, which no named key satisfies.
      .defineSchema({
        name: { presence: "required", propertyType: "param", primaryKey: true },
      } as any)
      .defineOperations({ create, read, delete: async () => undefined });
    const runtime = createRuntime(
      [new TestResource("looked-up", { config: { name: "app" } as any })],
      "effect-read",
      { failFirstSettle: true },
    );

    await expect(runtime.run("lookup-execution")).rejects.toMatchObject({
      name: "InfrastructureError",
    });
    expect(create).toHaveBeenCalledOnce();

    await runtime.run("lookup-execution");
    expect(create).toHaveBeenCalledOnce();
    // The lookup, then the read after create.
    expect(read).toHaveBeenCalledTimes(2);
    expect(read).toHaveBeenNthCalledWith(1, { name: "app" });
    expect(await runtime.state.get("looked-up")).toMatchObject({
      output: { name: "app" },
      version: 1,
    });
    runtime.close();
  });

  it("creates again after an interrupted create when the resource cannot be looked up", async () => {
    const create = vi.fn(async () => undefined);
    const TestResource = resource({ type: "test/durable/effect-no-read" })
      .defineSchema({})
      .defineOperations({ create, delete: async () => undefined });
    const runtime = createRuntime(
      [new TestResource("no-read")],
      "effect-no-read",
      { failFirstSettle: true },
    );

    await expect(runtime.run("no-read-execution")).rejects.toMatchObject({
      name: "InfrastructureError",
    });
    await runtime.run("no-read-execution");
    expect(create).toHaveBeenCalledTimes(2);
    expect(await runtime.state.get("no-read")).toMatchObject({ version: 1 });
    runtime.close();
  });

  it("finds a resource made by a create that threw an uncertain error", async () => {
    const tokens: string[] = [];
    const create = vi.fn(async (_params: unknown, _context: unknown, token) => {
      tokens.push(token!);
      throw new ProviderTimeoutError("socket timed out");
    });
    const findCreated = vi.fn(async (_params: unknown, token: string) => ({
      remoteId: `remote-for-${token}`,
    }));
    const TestResource = resource({ type: "test/durable/effect-find" })
      .defineSchema({
        remoteId: {
          presence: "required",
          propertyType: "computed",
          primaryKey: true,
        },
      } as any)
      .defineOperations({
        // Cast: a schema declared without API types infers no primary key.
        create: create as any,
        findCreated: findCreated as any,
        isUncertainError: (error) => error instanceof ProviderTimeoutError,
        delete: async () => undefined,
      });
    const runtime = createRuntime([new TestResource("found")], "effect-find");

    await expect(runtime.run("find-execution")).resolves.toMatchObject({
      status: "suspended",
    });
    runtime.advance(1_000);
    await runtime.run("find-execution");

    expect(create).toHaveBeenCalledOnce();
    expect(tokens).toEqual(["notation:create:find-execution:found:0"]);
    expect(findCreated).toHaveBeenCalledWith(
      {},
      "notation:create:find-execution:found:0",
    );
    expect(await runtime.state.get("found")).toMatchObject({
      output: { remoteId: "remote-for-notation:create:find-execution:found:0" },
      version: 1,
    });
    runtime.close();
  });

  it("fails a create that threw an uncertain error when the resource cannot be looked up", async () => {
    const create = vi.fn(async () => {
      throw new ProviderTimeoutError("socket timed out");
    });
    const TestResource = resource({ type: "test/durable/effect-unfindable" })
      .defineSchema({})
      .defineOperations({
        create,
        isUncertainError: (error) => error instanceof ProviderTimeoutError,
        delete: async () => undefined,
      });
    const runtime = createRuntime(
      [new TestResource("unfindable")],
      "effect-unfindable",
    );

    await expect(runtime.run("unfindable-execution")).rejects.toThrow(
      "socket timed out",
    );
    expect(create).toHaveBeenCalledOnce();
    runtime.close();
  });

  it("fails a create whose outcome stays unknown after the attempt limit", async () => {
    const create = vi.fn(async () => {
      throw new ProviderTimeoutError("socket timed out");
    });
    const findCreated = vi.fn(async () => {
      throw new Error("access denied");
    });
    const TestResource = resource({ type: "test/durable/effect-unknown" })
      .defineSchema({})
      .defineOperations({
        create,
        findCreated,
        isUncertainError: (error) => error instanceof ProviderTimeoutError,
        delete: async () => undefined,
      });
    const runtime = createRuntime(
      [new TestResource("unknown")],
      "effect-unknown",
      { maxOperationAttempts: 2 },
    );

    await expect(runtime.run("unknown-execution")).resolves.toMatchObject({
      status: "suspended",
    });
    runtime.advance(1_000);
    await expect(runtime.run("unknown-execution")).rejects.toMatchObject({
      name: "WorkflowEffectError",
      code: "EFFECT_OUTCOME_UNKNOWN",
    });
    expect(create).toHaveBeenCalledOnce();
    expect(findCreated).toHaveBeenCalledOnce();
    runtime.close();
  });

  it("stops looking up an uncertain create after the lookup limit", async () => {
    const create = vi.fn(async () => {
      throw new ProviderTimeoutError("socket timed out");
    });
    const findCreated = vi.fn(async () => {
      throw new Error("access denied");
    });
    const TestResource = resource({ type: "test/durable/effect-capped" })
      .defineSchema({})
      .defineOperations({
        create,
        findCreated,
        isUncertainError: (error) => error instanceof ProviderTimeoutError,
        delete: async () => undefined,
      });
    const runtime = createRuntime([new TestResource("capped")], "capped");

    for (let n = 1; n < 10; n += 1) {
      await expect(runtime.run("capped-execution")).resolves.toMatchObject({
        status: "suspended",
      });
      runtime.advance(1_000);
    }
    await expect(runtime.run("capped-execution")).rejects.toMatchObject({
      code: "EFFECT_OUTCOME_UNKNOWN",
    });
    expect(findCreated).toHaveBeenCalledTimes(9);
    runtime.close();
  });

  it("resumes after a crash following the delete checkpoint", async () => {
    const remove = vi.fn(async () => undefined);
    const TestResource = resource({ type: "test/durable/destroy-resume" })
      .defineSchema({})
      .defineOperations({ create: async () => undefined, delete: remove });
    const runtime = createRuntime(
      [new TestResource("destroyed")],
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
      [new PendingDelete("pending-delete")],
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
      [new EventuallyReadable("eventually-readable")],
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
      version: 1,
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
      [new MissingAfterCreate("missing-after-create")],
      "missing-after-create",
    );

    await expect(runtime.run("missing-after-create-execution")).rejects.toThrow(
      "resource is absent",
    );
    expect(await runtime.state.get("missing-after-create")).toBeUndefined();
    runtime.close();
  });
});

describe("durable values", () => {
  it("records a date in provider output as a date", async () => {
    const DatedResource = resource<{
      Key: {};
      CreateParams: {};
      UpdateParams: {};
      ReadResult: { CreatedDate: Date };
    }>({ type: "test/durable/dated" })
      .defineSchema({
        CreatedDate: { propertyType: "computed", presence: "required" },
      })
      .defineOperations({
        create: async () => undefined,
        read: async () => ({
          CreatedDate: new Date("2026-07-22T00:00:00.000Z"),
          Undeclared: new Date(),
        }),
        delete: async () => undefined,
      });
    const runtime = createRuntime([new DatedResource("dated")], "dated");

    await runtime.run("dated-execution");

    expect((await runtime.state.get("dated"))?.output).toEqual({
      CreatedDate: new Date("2026-07-22T00:00:00.000Z"),
    });
    runtime.close();
  });

  it("rejects a provider output that is not a durable value", async () => {
    const BytesResource = resource<{
      Key: {};
      CreateParams: {};
      UpdateParams: {};
      ReadResult: { Payload: string };
    }>({ type: "test/durable/bytes" })
      .defineSchema({
        Payload: { propertyType: "computed", presence: "required" },
      })
      .defineOperations({
        create: async () => undefined,
        // The type rejects a Buffer, so only an untyped provider can return
        // one.
        read: async () => ({ Payload: Buffer.from("bytes") }) as any,
        delete: async () => undefined,
      });
    const runtime = createRuntime([new BytesResource("bytes")], "bytes");

    await expect(runtime.run("bytes-execution")).rejects.toMatchObject({
      name: "WorkflowValueError",
      code: "INVALID_STEP_VALUE",
    });
    expect(await runtime.state.get("bytes")).toBeUndefined();
    runtime.close();
  });

  it("passes a date in a callback context to the next attempt", async () => {
    const contexts: unknown[] = [];
    const PendingResource = resource({ type: "test/durable/dated-context" })
      .defineSchema({})
      .defineOperations({
        create: async (_params, context) => {
          contexts.push(context);
          if (contexts.length === 1) {
            throw new ResourceOperationPendingError("provider is not ready", {
              retryAfterMs: RETRY_AFTER_MS,
              callbackContext: {
                startedAt: new Date("2026-07-22T00:00:00.000Z"),
              },
            });
          }
        },
        delete: async () => undefined,
      });
    const runtime = createRuntime(
      [new PendingResource("dated-context")],
      "dated-context",
      { maxOperationAttempts: 3 },
    );

    await expect(runtime.run("dated-context-execution")).resolves.toMatchObject(
      { status: "suspended" },
    );
    await sleep(PAST_RETRY_MS);
    await runtime.run("dated-context-execution");

    expect(contexts).toEqual([
      undefined,
      { startedAt: new Date("2026-07-22T00:00:00.000Z") },
    ]);
    expect((contexts[1] as { startedAt: unknown }).startedAt).toBeInstanceOf(
      Date,
    );
    expect(await runtime.state.get("dated-context")).toMatchObject({
      version: 1,
    });
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
    const dependency = new Dependency("dependency");
    const dependent = new Dependent("dependent", {
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
      new RaceResource("raced", { config: { name: "before" } }),
    ];
    const runtime = createRuntime(resources, "write-race");

    await runtime.run("deploy-1");
    resources[0] = new RaceResource("raced", { config: { name: "after" } });

    await expect(runtime.run("deploy-2")).rejects.toMatchObject({
      name: "VersionConflict",
    });
    // The losing write left the other writer's record intact.
    expect(await runtime.state.get("raced")).toMatchObject({
      version: 2,
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
      [new RaceResource("delete-raced")],
      "delete-race",
    );

    await runtime.run("deploy-1");
    await expect(runtime.destroy("destroy-1")).rejects.toMatchObject({
      name: "VersionConflict",
      // A conflict names the version the record moved to; only a genuinely
      // absent record may be reported as "missing".
      message: expect.stringMatching(/expected 1, got 2$/),
    });
    // State survives a removal that could not be proven safe.
    expect(await runtime.state.get("delete-raced")).toBeDefined();
    runtime.close();
  });

  // A record deleted and created again under the same ID starts back at the
  // version the workflow's snapshot was read at, so only the store's instance
  // ID tells the two records apart.
  it("rejects a state write whose record was deleted and created again", async () => {
    let recreatedInstanceId: string | undefined;
    const RaceResource = resource({ type: "test/durable/write-recreate-race" })
      // Cast: see "rejects a state write whose snapshot another writer has
      // moved past".
      .defineSchema({
        name: { presence: "required", propertyType: "param" },
      } as any)
      .defineOperations({
        create: async () => undefined,
        update: async () => {
          recreatedInstanceId = await recreateResourceState(
            runtime.storeClient,
            runtime.state.storeId("recreated"),
            "recreated",
          );
        },
        delete: async () => undefined,
      });
    const resources = [
      new RaceResource("recreated", { config: { name: "before" } }),
    ];
    const runtime = createRuntime(resources, "write-recreate-race");

    await runtime.run("deploy-1");
    const original = await runtime.state.snapshot("recreated");
    resources[0] = new RaceResource("recreated", {
      config: { name: "after" },
    });

    await expect(runtime.run("deploy-2")).rejects.toMatchObject({
      name: "VersionConflict",
    });
    // The version alone would have let the write through.
    const current = await runtime.state.snapshot("recreated");
    expect(current).toMatchObject({
      instanceId: recreatedInstanceId,
      version: original!.version,
      state: { lastOperationAt: "1999-01-01T00:00:00.000Z" },
    });
    expect(current!.instanceId).not.toBe(original!.instanceId);
    runtime.close();
  });

  it("rejects a state removal whose record was deleted and created again", async () => {
    let recreatedInstanceId: string | undefined;
    const RaceResource = resource({ type: "test/durable/delete-recreate-race" })
      .defineSchema({})
      .defineOperations({
        create: async () => undefined,
        delete: async () => {
          recreatedInstanceId = await recreateResourceState(
            runtime.storeClient,
            runtime.state.storeId("delete-recreated"),
            "delete-recreated",
          );
        },
      });
    const runtime = createRuntime(
      [new RaceResource("delete-recreated")],
      "delete-recreate-race",
    );

    await runtime.run("deploy-1");
    const original = await runtime.state.snapshot("delete-recreated");

    await expect(runtime.destroy("destroy-1")).rejects.toMatchObject({
      name: "VersionConflict",
    });
    // The record created after the snapshot was read survives.
    const current = await runtime.state.snapshot("delete-recreated");
    expect(current).toMatchObject({
      instanceId: recreatedInstanceId,
      version: original!.version,
      state: { lastOperationAt: "1999-01-01T00:00:00.000Z" },
    });
    expect(current!.instanceId).not.toBe(original!.instanceId);
    runtime.close();
  });
});

describe("deployment hold", () => {
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
    const runtime = createRuntime([new TestResource("shared")], "concurrent");

    const first = runtime.run("deployment-a");
    await createStarted;
    await runtime.run("deployment-b");
    expect(create).toHaveBeenCalledOnce();

    unblockCreate();
    await first;
    // Releasing the hold wakes the waiting execution.
    await runtime.run("deployment-b");

    expect(create).toHaveBeenCalledOnce();
    expect(await runtime.state.values()).toHaveLength(1);
    runtime.close();
  });

  it("releases the deployment hold when the workflow throws", async () => {
    let failCreate = true;
    const create = vi.fn(async () => {
      if (failCreate) throw new Error("create rejected");
    });
    const Resource = resource({ type: "test/durable/hold-release" })
      .defineSchema({})
      .defineOperations({ create, delete: async () => undefined });
    const runtime = createRuntime([new Resource("held")], "hold-release");

    await expect(runtime.run("failed-execution")).rejects.toThrow(
      "create rejected",
    );
    expect(await runtime.execution("failed-execution")).toMatchObject({
      status: "failed",
    });
    expect(await readHolder(runtime, "hold-release")).toBeNull();

    failCreate = false;
    await runtime.run("later-execution");
    expect(await runtime.state.get("held")).toMatchObject({
      lastOperation: "create",
    });
    runtime.close();
  });

  it("keeps the deployment hold when a delivery ends with an infrastructure error", async () => {
    const holders: Array<string | null> = [];
    const Resource = resource({ type: "test/durable/hold-replay" })
      .defineSchema({})
      .defineOperations({
        create: async () => {
          holders.push(await readHolder(runtime, "hold-replay"));
        },
        delete: async () => undefined,
      });
    const runtime = createRuntime(
      [new Resource("first"), new Resource("second")],
      "hold-replay",
      { crashAfterStep: "notation:deploy:first:create:remote:effect:0" },
    );

    await expect(runtime.run("replayed-execution")).rejects.toThrow(
      "simulated process crash",
    );
    expect(await readHolder(runtime, "hold-replay")).toBe("replayed-execution");

    await runtime.run("replayed-execution");
    // The second resource's create is the first uncached work after the
    // crash, so it observes the hold the resumed execution runs under.
    expect(holders).toEqual(["replayed-execution", "replayed-execution"]);
    expect(await readHolder(runtime, "hold-replay")).toBeNull();
    runtime.close();
  });

  it("emits a hold waiting event when another execution holds the deployment", async () => {
    let unblockCreate!: () => void;
    const blocked = new Promise<void>((resolve) => {
      unblockCreate = resolve;
    });
    let started!: () => void;
    const createStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const TestResource = resource({ type: "test/durable/hold" })
      .defineSchema({})
      .defineOperations({
        create: async () => {
          started();
          await blocked;
        },
        delete: async () => undefined,
      });
    const events: ReconcilerEvent[] = [];
    const runtime = createRuntime([new TestResource("held")], "hold-waiting", {
      emit: (event) => void events.push(event),
    });

    const first = runtime.run("holder-execution");
    await createStarted;
    await runtime.run("waiter-execution");

    expect(
      events.find((event) => event.event === "reconciler.hold.waiting"),
    ).toMatchObject({
      level: "warn",
      deploymentId: "hold-waiting",
      executionId: "waiter-execution",
      holderExecutionId: "holder-execution",
    });

    unblockCreate();
    await first;
    runtime.close();
  });
});

describe("deployment hold clearing", () => {
  it("clears a hold its named holder still has, and unblocks the deployment", async () => {
    const create = vi.fn(async () => undefined);
    const Resource = resource({ type: "test/durable/takeover" })
      .defineSchema({})
      .defineOperations({ create, delete: async () => undefined });
    const runtime = createRuntime([new Resource("held")], "takeover");
    await runtime.storeClient
      .store(durable.deploymentHoldStore, "takeover")
      .update(() => ({ holder: "abandoned-execution" }));

    const result = await durable.clearDeploymentHold({
      storeClient: runtime.storeClient,
      deploymentId: "takeover",
      fromExecutionId: "abandoned-execution",
    });

    expect(result).toEqual({
      cleared: true,
      previousHolder: "abandoned-execution",
    });
    await runtime.run("later-execution");
    expect(create).toHaveBeenCalledOnce();
    runtime.close();
  });

  it("refuses to clear a hold that has moved to another execution", async () => {
    const runtime = createRuntime([], "takeover-race");
    await runtime.storeClient
      .store(durable.deploymentHoldStore, "takeover-race")
      .update(() => ({ holder: "current-execution" }));

    const result = await durable.clearDeploymentHold({
      storeClient: runtime.storeClient,
      deploymentId: "takeover-race",
      fromExecutionId: "abandoned-execution",
    });

    expect(result).toEqual({ cleared: false, holder: "current-execution" });
    expect(await readHolder(runtime, "takeover-race")).toBe(
      "current-execution",
    );
    runtime.close();
  });

  it("reports no holder for a deployment that was never deployed", async () => {
    const runtime = createRuntime([], "never-deployed");

    const result = await durable.clearDeploymentHold({
      storeClient: runtime.storeClient,
      deploymentId: "never-deployed",
      fromExecutionId: "abandoned-execution",
    });

    expect(result).toEqual({ cleared: false, holder: null });
    runtime.close();
  });
});

describe("deployment scoping", () => {
  it("scopes store listing to the exact deployment despite prefix-like IDs", async () => {
    const database = createSqliteDb({ path: ":memory:" });
    const storeClient = new SqliteRuntime(database).stores;
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
    const resources: BaseResource[] = [new OrphanResource("orphan")];
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

describe("state from before groups had stable IDs", () => {
  const LegacyResource = resource({ type: "test/durable/legacy-group" })
    // Cast: a resource declared without API types constrains every schema
    // key to be a key of an `any` API schema, which no named key satisfies.
    .defineSchema({
      name: { presence: "required", propertyType: "param" },
    } as any)
    .defineOperations({
      create: async () => undefined,
      update: async () => undefined,
      delete: async () => undefined,
    });

  // Writes the record as an earlier version did, with a positional groupId
  // and groupType and no group. Written to SQLite directly, as the store
  // client would validate it against the current schema.
  function writeLegacyRecord(
    runtime: ReturnType<typeof createRuntime>,
    id: string,
  ) {
    const storeId = runtime.state.storeId(id);
    const row = runtime.database
      .query(
        "SELECT state FROM stores WHERE store_name = $storeName AND store_id = $storeId",
      )
      .get({
        $storeName: durable.resourceStateStore.name,
        $storeId: storeId,
      }) as { state: string };
    const { group: _, ...record } = JSON.parse(row.state);
    runtime.database
      .query(
        "UPDATE stores SET state = $state WHERE store_name = $storeName AND store_id = $storeId",
      )
      .run({
        $state: JSON.stringify({ ...record, groupId: 0, groupType: "Legacy" }),
        $storeName: durable.resourceStateStore.name,
        $storeId: storeId,
      });
  }

  function groupedResource(name: string) {
    const legacy = new LegacyResource("legacy", { config: { name } });
    legacy.group = { type: "Legacy", id: "legacy-group" };
    return legacy;
  }

  it("rewrites the record with the group when the resource is next updated", async () => {
    const resources: BaseResource[] = [groupedResource("before")];
    const runtime = createRuntime(resources, "legacy-group-update");

    await runtime.run("deploy-1");
    writeLegacyRecord(runtime, "legacy");
    expect(await runtime.state.get("legacy")).toMatchObject({
      groupId: 0,
      groupType: "Legacy",
    });

    resources[0] = groupedResource("after");
    await runtime.run("deploy-2");

    const node = await runtime.state.get("legacy");
    expect(node).toMatchObject({
      group: { type: "Legacy", id: "legacy-group" },
      params: { name: "after" },
    });
    expect(node).not.toHaveProperty("groupId");
    expect(node).not.toHaveProperty("groupType");
    runtime.close();
  });

  it("destroys a resource whose record predates stable group IDs", async () => {
    const runtime = createRuntime(
      [groupedResource("before")],
      "legacy-group-destroy",
    );

    await runtime.run("deploy-1");
    writeLegacyRecord(runtime, "legacy");
    await runtime.destroy("destroy-1");

    expect(await runtime.state.values()).toHaveLength(0);
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
      [new DriftResource("drifted", { config: { name: "expected" } })],
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

  it("trusts a noop for a resource with no read instead of reading during drift detection", async () => {
    const ReadlessResource = resource({ type: "test/durable/readless" })
      .defineSchema({})
      .defineOperations({
        create: async () => undefined,
        update: async () => undefined,
        delete: async () => undefined,
      });
    const events: ReconcilerEvent[] = [];
    const runtime = createRuntime(
      [new ReadlessResource("readless")],
      "readless-drift",
      { driftDetection: true, emit: (event) => void events.push(event) },
    );

    await runtime.run("deploy-1");
    events.length = 0;
    await runtime.run("deploy-2");

    // With nothing to read, the drift read would only replay persisted output
    // through read skip/success lifecycle events a plan never emits.
    expect(
      events.filter(
        (event) =>
          event.event === "reconciler.operation.lifecycle" &&
          event.operation === "read",
      ),
    ).toEqual([]);
    expect(
      events.find((event) => event.event === "reconciler.deploy.decision"),
    ).toMatchObject({ resourceId: "readless", decision: "noop" });
    runtime.close();
  });

  it("reads the remote during a dry run rather than reporting false drift", async () => {
    const remote = { name: "expected" };
    const read = vi.fn(async () => remote);
    const DryRunDriftResource = resource({ type: "test/durable/dry-run-drift" })
      .defineSchema({
        name: { presence: "required", propertyType: "param" },
      } as any)
      .defineOperations({
        create: (async () => remote) as any,
        read,
        update: async () => undefined,
        delete: async () => undefined,
      });
    const events: ReconcilerEvent[] = [];
    const options = {
      driftDetection: true,
      dryRun: false,
      emit: (event: ReconcilerEvent) => void events.push(event),
    };
    const runtime = createRuntime(
      [new DryRunDriftResource("steady", { config: { name: "expected" } })],
      "dry-run-drift",
      options,
    );

    await runtime.run("deploy-1");
    const readsAfterDeploy = read.mock.calls.length;

    options.dryRun = true;
    events.length = 0;
    await runtime.run("dry-run");

    // Suppressing the drift read under dryRun would leave decideAction
    // diffing an empty read against the desired params, which reports every
    // param as drift; skipping it entirely would make a dry run unable to
    // report the drift it exists to report.
    expect(read.mock.calls.length).toBeGreaterThan(readsAfterDeploy);
    expect(
      events.filter((event) => event.event === "reconciler.drift.detected"),
    ).toEqual([]);
    expect(
      events.find((event) => event.event === "reconciler.deploy.decision"),
    ).toMatchObject({ resourceId: "steady", decision: "noop" });
    runtime.close();
  });
});

describe("replacement", () => {
  /** A role-like resource whose path cannot change after creation. */
  function defineReplaceable(
    type: ResourceType,
    calls: string[],
    opts: { update?: boolean; read?: () => Promise<object> } = {},
  ) {
    return (
      resource({ type })
        // Cast: a resource declared without API types constrains every schema
        // key to be a key of an `any` API schema, which no named key satisfies.
        .defineSchema({
          name: { presence: "required", propertyType: "param" },
          path: {
            presence: "required",
            propertyType: "param",
            immutable: true,
          },
        } as any)
        .defineOperations({
          create: async (params: any) => {
            calls.push(`create:${params.path}`);
          },
          ...(opts.read ? { read: opts.read as any } : {}),
          ...(opts.update === false
            ? {}
            : {
                update: async () => {
                  calls.push("update");
                },
              }),
          delete: async (key: any, state: any) => {
            calls.push(`delete:${state.path}`);
          },
        })
    );
  }

  it("deletes and then creates a resource whose immutable param changed, under a new record", async () => {
    const calls: string[] = [];
    const Role = defineReplaceable("test/durable/replace", calls);
    const resources = [
      new Role("role", { config: { name: "app", path: "/" } as any }),
    ];
    const events: ReconcilerEvent[] = [];
    const runtime = createRuntime(resources, "replace", {
      emit: (event) => void events.push(event),
    });

    await runtime.run("deploy-1");
    const original = await runtime.state.snapshot("role");
    resources[0] = new Role("role", {
      config: { name: "app", path: "/service/" } as any,
    });
    await runtime.run("deploy-2");

    expect(calls).toEqual(["create:/", "delete:/", "create:/service/"]);
    const current = await runtime.state.snapshot("role");
    expect(current.state!.params).toEqual({ name: "app", path: "/service/" });
    expect(current.instanceId).not.toBe(original.instanceId);
    expect(
      events.filter(
        (event) =>
          event.event === "reconciler.deploy.decision" &&
          event.decision === "replace",
      ),
    ).toEqual([
      expect.objectContaining({
        resourceId: "role",
        replaceFields: [{ name: "path", known: true }],
      }),
    ]);
    runtime.close();
  });

  it("replaces a resource with no update rather than skipping the change", async () => {
    const calls: string[] = [];
    const Attachment = defineReplaceable("test/durable/no-update", calls, {
      update: false,
    });
    const resources = [
      new Attachment("attachment", {
        config: { name: "a", path: "/" } as any,
      }),
    ];
    const runtime = createRuntime(resources, "no-update");

    await runtime.run("deploy-1");
    resources[0] = new Attachment("attachment", {
      config: { name: "b", path: "/" } as any,
    });
    await runtime.run("deploy-2");
    await runtime.run("deploy-3");

    // The third deploy finds the change applied and does nothing.
    expect(calls).toEqual(["create:/", "delete:/", "create:/"]);
    expect(await runtime.state.get("attachment")).toMatchObject({
      params: { name: "b", path: "/" },
    });
    runtime.close();
  });

  it.each([
    [
      "the remote delete",
      "notation:deploy:role:replace:delete:delete:remote:attempt:0",
    ],
    ["the state record's removal", "state:delete:role"],
  ])(
    "resumes a replacement after a crash following %s",
    async (_, crashAfterStep) => {
      const calls: string[] = [];
      const Role = defineReplaceable("test/durable/replace-resume", calls);
      const resources = [
        new Role("role", { config: { name: "app", path: "/" } as any }),
      ];
      const runtime = createRuntime(resources, "replace-resume", {
        crashAfterStep,
      });

      await runtime.run("deploy-1");
      resources[0] = new Role("role", {
        config: { name: "app", path: "/service/" } as any,
      });
      await expect(runtime.run("deploy-2")).rejects.toThrow(
        "simulated process crash",
      );
      expect(calls).toEqual(["create:/", "delete:/"]);

      await runtime.run("deploy-2");
      expect(calls).toEqual(["create:/", "delete:/", "create:/service/"]);
      expect(await runtime.state.get("role")).toMatchObject({
        params: { name: "app", path: "/service/" },
      });
      runtime.close();
    },
  );

  it("plans a create after a replacement whose create failed", async () => {
    const calls: string[] = [];
    let failCreate = false;
    const Role = resource({ type: "test/durable/replace-failed" })
      .defineSchema({
        path: { presence: "required", propertyType: "param", immutable: true },
      } as any)
      .defineOperations({
        create: async (params: any) => {
          if (failCreate) throw new Error("create rejected");
          calls.push(`create:${params.path}`);
        },
        update: async () => undefined,
        delete: async (_key: any, state: any) => {
          calls.push(`delete:${state.path}`);
        },
      });
    const resources = [new Role("role", { config: { path: "/" } as any })];
    const events: ReconcilerEvent[] = [];
    const runtime = createRuntime(resources, "replace-failed", {
      emit: (event) => void events.push(event),
    });

    await runtime.run("deploy-1");
    resources[0] = new Role("role", {
      config: { path: "/service/" } as any,
    });
    failCreate = true;
    await expect(runtime.run("deploy-2")).rejects.toThrow("create rejected");
    expect(await runtime.state.get("role")).toBeUndefined();

    // The failed execution keeps the deployment hold until it is abandoned.
    await durable.clearDeploymentHold({
      storeClient: runtime.storeClient,
      deploymentId: "replace-failed",
      fromExecutionId: "deploy-2",
    });
    failCreate = false;
    events.length = 0;
    await runtime.run("deploy-3");
    expect(calls).toEqual(["create:/", "delete:/", "create:/service/"]);
    expect(
      events.find((event) => event.event === "reconciler.deploy.decision"),
    ).toMatchObject({ resourceId: "role", decision: "create" });
    runtime.close();
  });

  it("emits dry-run for both halves of a replacement and changes nothing", async () => {
    const calls: string[] = [];
    const Role = defineReplaceable("test/durable/replace-dry-run", calls);
    const resources = [
      new Role("role", { config: { name: "app", path: "/" } as any }),
    ];
    const events: ReconcilerEvent[] = [];
    const options = {
      dryRun: false,
      emit: (event: ReconcilerEvent) => void events.push(event),
    };
    const runtime = createRuntime(resources, "replace-dry-run", options);

    await runtime.run("deploy-1");
    const before = await runtime.state.snapshot("role");
    resources[0] = new Role("role", {
      config: { name: "app", path: "/service/" } as any,
    });
    options.dryRun = true;
    events.length = 0;
    await runtime.run("dry-run");

    expect(calls).toEqual(["create:/"]);
    expect(await runtime.state.snapshot("role")).toEqual(before);
    expect(
      events
        .filter(
          (event) =>
            event.event === "reconciler.operation.lifecycle" &&
            event.status === "dry-run",
        )
        .map((event) => (event as { operation: string }).operation),
    ).toEqual(["delete", "create"]);
    runtime.close();
  });

  it("replaces a resource whose remote drifted in an immutable param", async () => {
    const calls: string[] = [];
    let remote = { name: "app", path: "/" };
    const Role = defineReplaceable("test/durable/drift-replace", calls, {
      read: async () => remote,
    });
    const events: ReconcilerEvent[] = [];
    const runtime = createRuntime(
      [new Role("role", { config: { name: "app", path: "/" } as any })],
      "drift-replace",
      { driftDetection: true, emit: (event) => void events.push(event) },
    );

    await runtime.run("deploy-1");
    remote = { name: "app", path: "/drifted/" };
    events.length = 0;
    await runtime.run("deploy-2");

    expect(calls).toEqual(["create:/", "delete:/", "create:/"]);
    expect(
      events.find((event) => event.event === "reconciler.deploy.decision"),
    ).toMatchObject({
      decision: "drift-replace",
      replaceFields: [{ name: "path", known: true }],
    });
    runtime.close();
  });
});

function createRuntime(
  resources: BaseResource[],
  deploymentId: string,
  options: {
    maxOperationAttempts?: number;
    crashAfterStep?: string;
    /** Fails the first effect settle, as if the process died after perform. */
    failFirstSettle?: boolean;
    registry?: ResourceRegistry;
    driftDetection?: boolean;
    dryRun?: boolean;
    emit?: (event: ReconcilerEvent) => void;
  } = {},
) {
  const database = createSqliteDb({ path: ":memory:" });
  let skew = 0;
  const sqliteRuntime = new SqliteRuntime(database, {
    clock: () => Date.now() + skew,
  });
  const runtime: Runtime = {
    clock: sqliteRuntime.clock,
    executions: sqliteRuntime.executions,
    effects: options.failFirstSettle
      ? failFirstSettle(sqliteRuntime.effects)
      : sqliteRuntime.effects,
    heap: options.crashAfterStep
      ? new CrashAfterWriteHeap(sqliteRuntime.heap, options.crashAfterStep)
      : sqliteRuntime.heap,
    stores: sqliteRuntime.stores,
  };
  const storeClient = sqliteRuntime.stores;
  const state = new durable.DurableStateBackend(storeClient, deploymentId);
  const deploy = workflow(async function* (step, event) {
    yield* durable.deploy(step, {
      executionId: event.executionId,
      resources,
      state,
      registry: options.registry,
      driftDetection: options.driftDetection ?? false,
      // Read at execution time, so a test can switch it between runs.
      dryRun: options.dryRun,
      emit: options.emit,
      maxOperationAttempts: options.maxOperationAttempts,
    });
  });
  const destroy = workflow(async function* (step, event) {
    yield* durable.destroy(step, {
      executionId: event.executionId,
      resources,
      state,
      registry: options.registry,
      emit: options.emit,
      maxOperationAttempts: options.maxOperationAttempts,
    });
  });
  const router = createWorkflowRouter({ deploy, destroy });
  const runner = new WorkflowRunner(runtime, { router, logger });

  /**
   * Runs one delivery of the execution, admitting it first if it has no
   * record, and acknowledges the outcome as the dispatcher would. A failed
   * outcome rejects with the recorded error. A delivery that rejects releases
   * its lease, and the test clock skips the redelivery delay so the next
   * call can resume the execution.
   */
  async function deliver(workflowId: string, executionId: string) {
    if (!(await runtime.executions.get(executionId))) {
      const admission = await runtime.executions.admit({
        executionId,
        workflowId,
        params: {},
        context: new Map(),
      });
      if (admission.status === "rejected") throw new Error(admission.message);
    }
    const [lease] = await runtime.executions.claimDue({
      limit: 1,
      duration: 60_000,
      filter: { executionIds: [executionId] },
    });
    if (!lease) throw new Error(`Execution ${executionId} is not due`);

    let outcome;
    try {
      outcome = await runner.run(
        { workflowId, executionId, params: {}, context: new Map() },
        { lease, signal: new AbortController().signal },
      );
    } catch (error) {
      await runtime.executions.release({ lease });
      skew += REDELIVERY_DELAY_BASE;
      throw error;
    }
    await runtime.executions.acknowledge({ lease, outcome });
    if (outcome.status === "failed") throw outcome.error;
    return outcome;
  }

  return {
    runtime,
    state,
    storeClient,
    database,
    execution(executionId: string) {
      return runtime.executions.get(executionId);
    },
    run(executionId: string) {
      return deliver("deploy", executionId);
    },
    destroy(executionId: string) {
      return deliver("destroy", executionId);
    },
    /** Moves the runtime clock forward, so a suspended step is due. */
    advance(ms: number) {
      skew += ms;
    },
    close() {
      database.close();
    },
  };
}

/** Throws after the named step is recorded, as if the process died there. */
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
    lease: ExecutionLease;
    stepKey: string;
    stepAttempt: number;
    done: boolean;
    stepResponseJson: string;
  }) {
    const result = await this.inner.writeStep(params);
    if (
      !this.#crashed &&
      params.stepKey === this.crashAfterStep &&
      params.done
    ) {
      this.#crashed = true;
      throw new Error("simulated process crash");
    }
    return result;
  }
}

function failFirstSettle(inner: EffectClient): EffectClient {
  let failed = false;
  return {
    begin: (request) => inner.begin(request),
    watch: (request) => inner.watch(request),
    getEffect: (effectId) => inner.getEffect(effectId),
    settle(request) {
      if (failed) return inner.settle(request);
      failed = true;
      return Promise.reject(new Error("simulated process crash"));
    },
  };
}

class ProviderTimeoutError extends Error {
  name = "ProviderTimeoutError";
}

async function readHolder(
  runtime: ReturnType<typeof createRuntime>,
  deploymentId: string,
) {
  const hold = runtime.storeClient.store(
    durable.deploymentHoldStore,
    deploymentId,
  );
  return (await hold.get()).state.holder;
}

function seedResourceState(
  storeClient: StoreClient,
  storeId: string,
  resourceId: string,
) {
  return storeClient
    .store(durable.resourceStateStore, storeId)
    .update(() => resourceStateRecord(resourceId));
}

/** Deletes a resource's store and creates it again, returning the new instance ID. */
async function recreateResourceState(
  storeClient: StoreClient,
  storeId: string,
  resourceId: string,
) {
  await storeClient.deleteStore({
    definition: durable.resourceStateStore,
    id: storeId,
  });
  const store = storeClient.store(durable.resourceStateStore, storeId);
  await store.update(() => ({
    ...resourceStateRecord(resourceId),
    lastOperationAt: "1999-01-01T00:00:00.000Z",
  }));
  return (await store.get()).instanceId;
}

function resourceStateRecord(id: string) {
  return {
    id,
    type: "test/durable/state",
    group: null,
    config: {},
    params: {},
    output: {},
    lastOperation: "create" as const,
    lastOperationAt: new Date().toISOString(),
  };
}
