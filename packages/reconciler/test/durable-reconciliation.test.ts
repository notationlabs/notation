import * as v from "valibot";
import {
  REDELIVERY_DELAY_BASE,
  WorkflowRunner,
  type EffectClient,
  type HeapClient,
  type Runtime,
  type StoreClient,
} from "@notation/durable/runtime";
import { SqliteRuntime, createSqliteDb } from "@notation/durable/sqlite/node";
import {
  resource,
  ResourceCreationUnknownError,
  ResourceNotFoundError,
  type ResourceDeletion,
  ResourceOperationPendingError,
  SchemaStructureError,
  ValueValidationError,
  mergeContributions,
  type BaseResource,
  type ResourceType,
} from "@notation/resource";
import { setTimeout as sleep } from "node:timers/promises";
import pino from "pino";
import { createWorkflowRouter, workflow } from "@notation/durable";
import { describe, expect, it, vi } from "vitest";
import * as durable from "../src/durable";
import type { ReconcilerEvent } from "../src/events";
import {
  createResourceRegistry,
  type ResourceRegistry,
} from "../src/resource-registry";
import { ResourceTypeChangedError } from "../src/resource-type";
import { ResourceCycleError } from "../src/cycles";

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
    const PendingResource = resource({
      type: "test/durable/pending",
      provider: "test",
    })
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
    const TestResource = resource({
      type: "test/durable/resume",
      provider: "test",
    })
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
    const TestResource = resource({
      type: "test/durable/effect-read",
      provider: "test",
    })
      // Cast: a resource declared without API types constrains every schema
      // key to be a key of an `any` API schema, which no named key satisfies.
      .defineSchema({
        name: {
          presence: "required",
          propertyType: "param",
          primaryKey: true,
          value: v.string(),
        },
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
    const TestResource = resource({
      type: "test/durable/effect-no-read",
      provider: "test",
    })
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

  it("finds a resource made by a create with an unknown outcome", async () => {
    const tokens: string[] = [];
    const create = vi.fn(async (_params: unknown, _context: unknown, token) => {
      tokens.push(token!);
      throw new ResourceCreationUnknownError("socket timed out");
    });
    const find = vi.fn(async (_params: unknown, token: string) => ({
      remoteId: `remote-for-${token}`,
    }));
    const TestResource = resource({
      type: "test/durable/effect-find",
      provider: "test",
    })
      .defineSchema({
        remoteId: {
          value: v.string(),
          presence: "required",
          propertyType: "computed",
          primaryKey: true,
        },
      } as any)
      .defineOperations({
        // Cast: a schema declared without API types infers no primary key.
        create: create as any,
        find: find as any,
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
    expect(find).toHaveBeenCalledWith(
      {},
      "notation:create:find-execution:found:0",
    );
    expect(await runtime.state.get("found")).toMatchObject({
      output: { remoteId: "remote-for-notation:create:find-execution:found:0" },
      version: 1,
    });
    runtime.close();
  });

  it("looks a create with an unknown outcome up again when the read is throttled", async () => {
    const create = vi
      .fn()
      .mockRejectedValueOnce(
        new ResourceCreationUnknownError("socket timed out"),
      )
      .mockResolvedValue(undefined);
    const read = vi
      .fn()
      .mockRejectedValueOnce(
        new ResourceOperationPendingError("rate limited", {
          retryAfterMs: RETRY_AFTER_MS,
          throttled: true,
        }),
      )
      .mockRejectedValueOnce(new ResourceNotFoundError("not found"))
      .mockResolvedValue({ name: "app" });
    const TestResource = resource({
      type: "test/durable/effect-throttled-read",
      provider: "test",
    })
      .defineSchema({
        name: {
          presence: "required",
          propertyType: "param",
          primaryKey: true,
          value: v.string(),
        },
      } as any)
      .defineOperations({ create, read, delete: async () => undefined });
    const runtime = createRuntime(
      [new TestResource("throttled", { config: { name: "app" } as any })],
      "effect-throttled-read",
    );

    await expect(runtime.run("throttled-execution")).resolves.toMatchObject({
      status: "suspended",
    });
    runtime.advance(1_000);
    await expect(runtime.run("throttled-execution")).resolves.toMatchObject({
      status: "suspended",
    });
    runtime.advance(1_000);
    await runtime.run("throttled-execution");

    // The throttled read didn't count as finding the resource, so the
    // lookup ran again, found nothing, and the create ran a second time.
    expect(create).toHaveBeenCalledTimes(2);
    expect(await runtime.state.get("throttled")).toMatchObject({
      output: { name: "app" },
      version: 1,
    });
    runtime.close();
  });

  it("fails a create with an unknown outcome when the resource cannot be looked up", async () => {
    const create = vi.fn(async () => {
      throw new ResourceCreationUnknownError("socket timed out");
    });
    const TestResource = resource({
      type: "test/durable/effect-unfindable",
      provider: "test",
    })
      .defineSchema({})
      .defineOperations({
        create,
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
      throw new ResourceCreationUnknownError("socket timed out");
    });
    const find = vi.fn(async () => {
      throw new Error("access denied");
    });
    const TestResource = resource({
      type: "test/durable/effect-unknown",
      provider: "test",
    })
      .defineSchema({})
      .defineOperations({
        create,
        find,
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
    expect(find).toHaveBeenCalledOnce();
    runtime.close();
  });

  it("stops looking up a create with an unknown outcome after the lookup limit", async () => {
    const create = vi.fn(async () => {
      throw new ResourceCreationUnknownError("socket timed out");
    });
    const find = vi.fn(async () => {
      throw new Error("access denied");
    });
    const TestResource = resource({
      type: "test/durable/effect-capped",
      provider: "test",
    })
      .defineSchema({})
      .defineOperations({
        create,
        find,
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
    expect(find).toHaveBeenCalledTimes(9);
    runtime.close();
  });

  it("resumes after a crash following the delete checkpoint", async () => {
    const remove = vi.fn(async () => undefined);
    const TestResource = resource({
      type: "test/durable/destroy-resume",
      provider: "test",
    })
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
    const PendingDelete = resource({
      type: "test/durable/pending-delete",
      provider: "test",
    })
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
      provider: "test",
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
      provider: "test",
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
    }>({ type: "test/durable/dated", provider: "test" })
      .defineSchema({
        CreatedDate: {
          propertyType: "computed",
          presence: "required",
          value: v.date(),
        },
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
    }>({ type: "test/durable/bytes", provider: "test" })
      .defineSchema({
        Payload: {
          propertyType: "computed",
          presence: "required",
          value: v.string(),
        },
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
    const PendingResource = resource({
      type: "test/durable/dated-context",
      provider: "test",
    })
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
    const Dependency = resource({
      type: "test/durable/dependency",
      provider: "test",
    })
      .defineSchema({})
      .defineOperations({
        create: async () => undefined,
        delete: async () => void order.push("dependency"),
      });
    const Dependent = resource({
      type: "test/durable/dependent",
      provider: "test",
    })
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
    const RaceResource = resource({
      type: "test/durable/write-race",
      provider: "test",
    })
      // Cast: a resource declared without API types constrains every schema
      // key to be a key of an `any` API schema, which no named key satisfies.
      .defineSchema({
        name: {
          presence: "required",
          propertyType: "param",
          value: v.string(),
        },
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
    const RaceResource = resource({
      type: "test/durable/delete-race",
      provider: "test",
    })
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
    const RaceResource = resource({
      type: "test/durable/write-recreate-race",
      provider: "test",
    })
      // Cast: see "rejects a state write whose snapshot another writer has
      // moved past".
      .defineSchema({
        name: {
          presence: "required",
          propertyType: "param",
          value: v.string(),
        },
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
    const RaceResource = resource({
      type: "test/durable/delete-recreate-race",
      provider: "test",
    })
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
    const TestResource = resource({
      type: "test/durable/concurrent",
      provider: "test",
    })
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
    const Resource = resource({
      type: "test/durable/hold-release",
      provider: "test",
    })
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
    const Resource = resource({
      type: "test/durable/hold-replay",
      provider: "test",
    })
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
    const TestResource = resource({
      type: "test/durable/hold",
      provider: "test",
    })
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
    const Resource = resource({
      type: "test/durable/takeover",
      provider: "test",
    })
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
    const OrphanResource = resource({
      type: "test/durable/orphan",
      provider: "test",
    })
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

  it("deletes orphans through the registry and the classes of the graph together", async () => {
    const deleted: string[] = [];
    const define = (type: string) =>
      resource({ type: type as ResourceType, provider: "test" })
        .defineSchema({})
        .defineOperations({
          create: async () => undefined,
          delete: async () => void deleted.push(type),
        });
    const InGraph = define("test/durable/in-graph");
    const Registered = define("test/durable/registered");
    const resources: BaseResource[] = [
      new InGraph("kept"),
      new InGraph("in-graph-orphan"),
      new Registered("registered-orphan"),
    ];
    const runtime = createRuntime(resources, "orphan-merged-registry", {
      registry: createResourceRegistry([Registered]),
    });
    await runtime.run("deploy-1");

    resources.splice(1);
    await runtime.run("deploy-2");

    expect(deleted.sort()).toEqual([
      "test/durable/in-graph",
      "test/durable/registered",
    ]);
    expect((await runtime.state.values()).map((node) => node.id)).toEqual([
      "kept",
    ]);
    runtime.close();
  });
});

// Rewrites a record as an earlier version wrote it, with no edges. Written
// to SQLite directly, as the store client would validate it against the
// current schema.
function removeEdges(runtime: ReturnType<typeof createRuntime>, id: string) {
  const where = {
    $storeName: durable.resourceStateStore.name,
    $storeId: runtime.state.storeId(id),
  };
  const row = runtime.database
    .query(
      "SELECT state FROM stores WHERE store_name = $storeName AND store_id = $storeId",
    )
    .get(where) as { state: string };
  const { dependsOn: _, ...record } = JSON.parse(row.state);
  runtime.database
    .query(
      "UPDATE stores SET state = $state WHERE store_name = $storeName AND store_id = $storeId",
    )
    .run({ ...where, $state: JSON.stringify(record) });
}

describe("a resource whose state record has another type", () => {
  function defineTyped(type: string, calls: string[]) {
    return resource({ type: type as ResourceType, provider: "test" })
      .defineSchema({})
      .defineOperations({
        create: async () => void calls.push(`create ${type}`),
        delete: async () => void calls.push(`delete ${type}`),
      });
  }

  it("fails deploy before any change", async () => {
    const calls: string[] = [];
    const Old = defineTyped("test/durable/old", calls);
    const New = defineTyped("test/durable/new", calls);
    const resources: BaseResource[] = [new Old("permission")];
    const runtime = createRuntime(resources, "type-changed-deploy", {
      registry: createResourceRegistry([Old]),
    });
    await runtime.run("deploy-1");

    resources[0] = new New("permission");
    const deploy = runtime.run("deploy-2");

    await expect(deploy).rejects.toSatisfy(ResourceTypeChangedError.is);
    await expect(deploy).rejects.toThrow(
      "Resource permission has type test/durable/new in the graph, but its state record has type test/durable/old",
    );
    expect(calls).toEqual(["create test/durable/old"]);
    expect(await runtime.state.get("permission")).toMatchObject({
      type: "test/durable/old",
    });
    runtime.close();
  });

  it("destroys the record through the class of its type, in dependency order", async () => {
    const calls: string[] = [];
    const Old = defineTyped("test/durable/old", calls);
    const New = defineTyped("test/durable/new", calls);
    const Role = defineTyped("test/durable/role", calls);
    const Fn = defineTyped("test/durable/fn", calls);
    const role = new Role("role");
    const resources: BaseResource[] = [
      role,
      new Old("permission", { dependencies: { role } }),
    ];
    const runtime = createRuntime(resources, "type-changed-destroy", {
      registry: createResourceRegistry([Old]),
    });
    await runtime.run("deploy-1");

    const permission = new New("permission", { dependencies: { role } });
    resources.splice(
      1,
      1,
      permission,
      new Fn("fn", { dependencies: { permission } }),
    );
    calls.length = 0;
    await runtime.destroy("destroy-1");

    expect(calls).toEqual([
      "delete test/durable/old",
      "delete test/durable/role",
    ]);
    expect(await runtime.state.values()).toEqual([]);
    runtime.close();
  });

  it("keeps the record and its dependencies in destroy when the class of its type is not registered", async () => {
    const calls: string[] = [];
    const events: ReconcilerEvent[] = [];
    const Old = defineTyped("test/durable/old", calls);
    const New = defineTyped("test/durable/new", calls);
    const Role = defineTyped("test/durable/role", calls);
    const Other = defineTyped("test/durable/other", calls);
    const role = new Role("role");
    const resources: BaseResource[] = [
      role,
      new Old("permission", { dependencies: { role } }),
      new Other("other"),
    ];
    const runtime = createRuntime(resources, "type-changed-unregistered", {
      registry: createResourceRegistry([]),
      emit: (event) => void events.push(event),
    });
    await runtime.run("deploy-1");

    resources[1] = new New("permission", { dependencies: { role } });
    calls.length = 0;
    await runtime.destroy("destroy-1");

    expect(calls).toEqual(["delete test/durable/other"]);
    expect(
      events.filter(
        (event) => event.event === "reconciler.orphan-deletion.skipped",
      ),
    ).toEqual([
      expect.objectContaining({
        workflow: "destroy",
        resourceId: "permission",
        resourceType: "test/durable/old",
        keptDependencies: ["role"],
      }),
    ]);
    expect(
      (await runtime.state.values()).map((node) => node.id).sort(),
    ).toEqual(["permission", "role"]);
    runtime.close();
  });
});

describe("dependency edges in state", () => {
  function defineRecorded(type: string, deleted: string[]) {
    return resource({ type: type as ResourceType, provider: "test" })
      .defineSchema({})
      .defineOperations({
        create: async () => undefined,
        delete: async () => void deleted.push(type),
      });
  }

  it("records each resource's dependencies, sorted", async () => {
    const Recorded = defineRecorded("test/durable/recorded", []);
    const zip = new Recorded("zip");
    const role = new Recorded("role");
    const fn = new Recorded("fn", { dependencies: { zip, role, again: role } });
    const runtime = createRuntime([zip, role, fn], "edges-recorded");

    await runtime.run("deploy-1");

    expect(await runtime.state.get("fn")).toMatchObject({
      dependsOn: ["role", "zip"],
    });
    expect(await runtime.state.get("role")).toMatchObject({ dependsOn: [] });
    runtime.close();
  });

  it("rewrites only the edges of a resource whose edges changed", async () => {
    const updateSpy = vi.fn(async () => undefined);
    const Recorded = resource({
      type: "test/durable/rewired",
      provider: "test",
    })
      .defineSchema({})
      .defineOperations({
        create: async () => undefined,
        update: updateSpy,
        delete: async () => undefined,
      });
    const first = new Recorded("first");
    const second = new Recorded("second");
    const resources: BaseResource[] = [
      first,
      second,
      new Recorded("dependent", { dependencies: { first } }),
    ];
    const runtime = createRuntime(resources, "edges-rewritten");

    await runtime.run("deploy-1");
    const before = await runtime.state.get("dependent");

    resources[2] = new Recorded("dependent", { dependencies: { second } });
    await runtime.run("deploy-2");
    const after = await runtime.state.get("dependent");

    expect(updateSpy).not.toHaveBeenCalled();
    expect(after).toEqual({
      ...before,
      version: before!.version + 1,
      dependsOn: ["second"],
    });
    runtime.close();
  });

  it("rewrites the provider package of a resource whose class moved package", async () => {
    const updateSpy = vi.fn(async () => undefined);
    const define = (provider: string) =>
      resource({ type: "test/durable/moved", provider })
        .defineSchema({})
        .defineOperations({
          create: async () => undefined,
          update: updateSpy,
          delete: async () => undefined,
        });
    const resources: BaseResource[] = [new (define("@acme/old"))("moved")];
    const runtime = createRuntime(resources, "provider-rewritten");

    await runtime.run("deploy-1");
    resources[0] = new (define("@acme/new"))("moved");
    await runtime.run("deploy-2");

    expect(updateSpy).not.toHaveBeenCalled();
    expect(await runtime.state.get("moved")).toMatchObject({
      provider: "@acme/new",
      version: 2,
    });
    runtime.close();
  });

  it("leaves a record whose edges are unchanged as it is", async () => {
    const Recorded = defineRecorded("test/durable/unchanged", []);
    const role = new Recorded("role");
    const fn = new Recorded("fn", { dependencies: { role } });
    const runtime = createRuntime([role, fn], "edges-unchanged");

    await runtime.run("deploy-1");
    await runtime.run("deploy-2");

    expect(await runtime.state.get("fn")).toMatchObject({ version: 1 });
    runtime.close();
  });

  it("does not rewrite edges in a dry run", async () => {
    const Recorded = defineRecorded("test/durable/dry-edges", []);
    const role = new Recorded("role");
    const resources: BaseResource[] = [role, new Recorded("fn")];
    const options: { dryRun?: boolean } = {};
    const runtime = createRuntime(resources, "edges-dry-run", options);

    await runtime.run("deploy-1");
    resources[1] = new Recorded("fn", { dependencies: { role } });
    options.dryRun = true;
    await runtime.run("deploy-2");

    expect(await runtime.state.get("fn")).toMatchObject({
      version: 1,
      dependsOn: [],
    });
    runtime.close();
  });

  it("writes the edges of a record that predates them on the next deploy", async () => {
    const Recorded = defineRecorded("test/durable/legacy-edges", []);
    const role = new Recorded("role");
    const fn = new Recorded("fn", { dependencies: { role } });
    const runtime = createRuntime([role, fn], "edges-legacy");

    await runtime.run("deploy-1");
    removeEdges(runtime, "fn");
    expect(await runtime.state.get("fn")).not.toHaveProperty("dependsOn");

    await runtime.run("deploy-2");

    expect(await runtime.state.get("fn")).toMatchObject({
      dependsOn: ["role"],
    });
    runtime.close();
  });

  it("deletes orphans in reverse dependency order, whatever order state lists them in", async () => {
    const deleted: string[] = [];
    const Role = defineRecorded("test/durable/role", deleted);
    const Attachment = defineRecorded("test/durable/attachment", deleted);
    const Fn = defineRecorded("test/durable/fn", deleted);
    const LogGroup = defineRecorded("test/durable/log-group", deleted);
    // State lists records by ID, so the role comes before what depends on it.
    const role = new Role("a-role");
    const fn = new Fn("b-fn", { dependencies: { role } });
    const resources: BaseResource[] = [
      role,
      new Attachment("c-attachment", { dependencies: { role } }),
      fn,
      new LogGroup("d-log-group", { dependencies: { fn } }),
    ];
    const runtime = createRuntime(resources, "orphan-order", {
      registry: createResourceRegistry([Role, Attachment, Fn, LogGroup]),
    });

    await runtime.run("deploy-1");
    resources.length = 0;
    await runtime.run("deploy-2");

    expect(deleted).toEqual([
      "test/durable/log-group",
      "test/durable/fn",
      "test/durable/attachment",
      "test/durable/role",
    ]);
    expect(await runtime.state.values()).toHaveLength(0);
    runtime.close();
  });

  it("ignores an edge to a resource that is no longer in state", async () => {
    const deleted: string[] = [];
    const Role = defineRecorded("test/durable/lost-role", deleted);
    const Fn = defineRecorded("test/durable/lost-fn", deleted);
    const role = new Role("role");
    const resources: BaseResource[] = [
      role,
      new Fn("fn", { dependencies: { role } }),
    ];
    const runtime = createRuntime(resources, "orphan-lost-edge", {
      registry: createResourceRegistry([Role, Fn]),
    });

    await runtime.run("deploy-1");
    await runtime.storeClient.deleteStore({
      definition: durable.resourceStateStore,
      id: runtime.state.storeId("role"),
    });
    resources.length = 0;
    await runtime.run("deploy-2");

    expect(deleted).toEqual(["test/durable/lost-fn"]);
    expect(await runtime.state.values()).toHaveLength(0);
    runtime.close();
  });

  it("keeps the dependencies of an orphan it cannot delete, and names them", async () => {
    const deleted: string[] = [];
    const events: ReconcilerEvent[] = [];
    const Role = defineRecorded("test/durable/kept-role", deleted);
    const Fn = defineRecorded("test/durable/kept-fn", deleted);
    const Unregistered = defineRecorded("test/durable/unregistered", deleted);
    const Other = defineRecorded("test/durable/other", deleted);
    const role = new Role("role");
    const fn = new Fn("fn", { dependencies: { role } });
    const resources: BaseResource[] = [
      role,
      fn,
      new Unregistered("attachment", { dependencies: { fn } }),
      new Other("other"),
    ];
    const runtime = createRuntime(resources, "orphan-kept", {
      registry: createResourceRegistry([Role, Fn, Other]),
      emit: (event) => void events.push(event),
    });

    await runtime.run("deploy-1");
    resources.length = 0;
    await runtime.run("deploy-2");

    expect(deleted).toEqual(["test/durable/other"]);
    expect(
      events.filter(
        (event) => event.event === "reconciler.orphan-deletion.skipped",
      ),
    ).toEqual([
      expect.objectContaining({
        resourceId: "attachment",
        keptDependencies: ["fn", "role"],
      }),
    ]);
    expect((await runtime.state.values()).map((node) => node.id)).toEqual(
      expect.arrayContaining(["attachment", "fn", "role"]),
    );
    runtime.close();
  });

  it("names a shared dependency in the warning of every orphan that keeps it", async () => {
    const deleted: string[] = [];
    const events: ReconcilerEvent[] = [];
    const Role = defineRecorded("test/durable/shared-role", deleted);
    const Unregistered = defineRecorded("test/durable/shared-skip", deleted);
    const role = new Role("role");
    const resources: BaseResource[] = [
      role,
      new Unregistered("first", { dependencies: { role } }),
      new Unregistered("second", { dependencies: { role } }),
    ];
    const runtime = createRuntime(resources, "orphan-shared-kept", {
      registry: createResourceRegistry([Role]),
      emit: (event) => void events.push(event),
    });

    await runtime.run("deploy-1");
    resources.length = 0;
    await runtime.run("deploy-2");

    expect(deleted).toEqual([]);
    expect(
      events.filter(
        (event) => event.event === "reconciler.orphan-deletion.skipped",
      ),
    ).toEqual([
      expect.objectContaining({
        resourceId: "first",
        keptDependencies: ["role"],
      }),
      expect.objectContaining({
        resourceId: "second",
        keptDependencies: ["role"],
      }),
    ]);
    runtime.close();
  });

  it("warns for an unregistered orphan that another skipped orphan keeps", async () => {
    const events: ReconcilerEvent[] = [];
    const Unregistered = defineRecorded("test/durable/chained-skip", []);
    const inner = new Unregistered("inner");
    const resources: BaseResource[] = [
      inner,
      new Unregistered("outer", { dependencies: { inner } }),
    ];
    const runtime = createRuntime(resources, "orphan-chained-kept", {
      registry: createResourceRegistry([]),
      emit: (event) => void events.push(event),
    });

    await runtime.run("deploy-1");
    resources.length = 0;
    await runtime.run("deploy-2");

    expect(
      events.filter(
        (event) => event.event === "reconciler.orphan-deletion.skipped",
      ),
    ).toEqual([
      expect.objectContaining({
        resourceId: "outer",
        keptDependencies: ["inner"],
      }),
      expect.objectContaining({ resourceId: "inner", keptDependencies: [] }),
    ]);
    runtime.close();
  });

  it("destroys an orphan before the desired resource it depends on", async () => {
    const deleted: string[] = [];
    const Role = defineRecorded("test/durable/destroy-role", deleted);
    const Attachment = defineRecorded(
      "test/durable/destroy-attachment",
      deleted,
    );
    const role = new Role("role");
    const resources: BaseResource[] = [
      role,
      new Attachment("attachment", { dependencies: { role } }),
    ];
    const runtime = createRuntime(resources, "destroy-orphan-first", {
      registry: createResourceRegistry([Role, Attachment]),
    });

    await runtime.run("deploy-1");
    resources.length = 1;
    await runtime.destroy("destroy-1");

    expect(deleted).toEqual([
      "test/durable/destroy-attachment",
      "test/durable/destroy-role",
    ]);
    expect(await runtime.state.values()).toHaveLength(0);
    runtime.close();
  });

  it("keeps the desired resources an unregistered orphan depends on through destroy", async () => {
    const deleted: string[] = [];
    const events: ReconcilerEvent[] = [];
    const Policy = defineRecorded("test/durable/kept-policy", deleted);
    const Role = defineRecorded("test/durable/kept-desired-role", deleted);
    const Fn = defineRecorded("test/durable/kept-desired-fn", deleted);
    const Unregistered = defineRecorded(
      "test/durable/kept-attachment",
      deleted,
    );
    const policy = new Policy("policy");
    const role = new Role("role", { dependencies: { policy } });
    const resources: BaseResource[] = [
      policy,
      role,
      new Fn("fn", { dependencies: { role } }),
      new Unregistered("attachment", { dependencies: { role } }),
    ];
    const runtime = createRuntime(resources, "destroy-kept-desired", {
      registry: createResourceRegistry([Policy, Role, Fn]),
      emit: (event) => void events.push(event),
    });

    await runtime.run("deploy-1");
    resources.length = 3;
    await runtime.destroy("destroy-1");

    expect(deleted).toEqual(["test/durable/kept-desired-fn"]);
    expect(
      events.filter(
        (event) => event.event === "reconciler.orphan-deletion.skipped",
      ),
    ).toEqual([
      expect.objectContaining({
        workflow: "destroy",
        resourceId: "attachment",
        keptDependencies: ["policy", "role"],
      }),
    ]);
    expect(
      (await runtime.state.values()).map((node) => node.id).sort(),
    ).toEqual(["attachment", "policy", "role"]);
    runtime.close();
  });

  it("names only orphans as kept in deploy, which deletes no desired resource", async () => {
    const events: ReconcilerEvent[] = [];
    const Role = defineRecorded("test/durable/deploy-desired-role", []);
    const Unregistered = defineRecorded("test/durable/deploy-attachment", []);
    const role = new Role("role");
    const resources: BaseResource[] = [
      role,
      new Unregistered("attachment", { dependencies: { role } }),
    ];
    const runtime = createRuntime(resources, "deploy-kept-desired", {
      registry: createResourceRegistry([Role]),
      emit: (event) => void events.push(event),
    });

    await runtime.run("deploy-1");
    resources.length = 1;
    await runtime.run("deploy-2");

    expect(
      events.filter(
        (event) => event.event === "reconciler.orphan-deletion.skipped",
      ),
    ).toEqual([
      expect.objectContaining({
        workflow: "deploy",
        resourceId: "attachment",
        keptDependencies: [],
      }),
    ]);
    runtime.close();
  });
});

describe("state from before groups had stable IDs", () => {
  const LegacyResource = resource({
    type: "test/durable/legacy-group",
    provider: "test",
  })
    // Cast: a resource declared without API types constrains every schema
    // key to be a key of an `any` API schema, which no named key satisfies.
    .defineSchema({
      name: { presence: "required", propertyType: "param", value: v.string() },
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
    const DriftResource = resource({
      type: "test/durable/drift",
      provider: "test",
    })
      // Cast: a resource declared without API types constrains every schema
      // key to be a key of an `any` API schema, which no named key satisfies.
      .defineSchema({
        name: {
          presence: "required",
          propertyType: "param",
          value: v.string(),
        },
      } as any)
      .defineOperations({
        create: async () => undefined,
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
    const ReadlessResource = resource({
      type: "test/durable/readless",
      provider: "test",
    })
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
    const DryRunDriftResource = resource({
      type: "test/durable/dry-run-drift",
      provider: "test",
    })
      .defineSchema({
        name: {
          presence: "required",
          propertyType: "param",
          value: v.string(),
        },
      } as any)
      .defineOperations({
        create: async () => undefined,
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
      resource({ type, provider: "test" })
        // Cast: a resource declared without API types constrains every schema
        // key to be a key of an `any` API schema, which no named key satisfies.
        .defineSchema({
          name: {
            presence: "required",
            propertyType: "param",
            value: v.string(),
          },
          path: {
            value: v.string(),
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
    const Role = resource({
      type: "test/durable/replace-failed",
      provider: "test",
    })
      .defineSchema({
        path: {
          presence: "required",
          propertyType: "param",
          immutable: true,
          value: v.string(),
        },
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

describe("replacement with dependents", () => {
  /**
   * Resources named by a key, as AWS names a bus and its rules. A resource
   * cannot be deleted while a resource of a type that blocks its delete names
   * it as its parent, as AWS refuses to delete a bus that has rules. A
   * permission, or a function with the bus name in its env, does not block
   * the delete of its parent.
   */
  function defineWorld() {
    const calls: string[] = [];
    const live = new Map<string, { parent?: string; blocks: boolean }>();
    const failCreate = new Set<string>();
    const operations = (blocks: boolean) => ({
      create: async (params: any) => {
        if (failCreate.has(params.name)) {
          throw new Error(`create ${params.name} rejected`);
        }
        if (params.parent && !live.has(params.parent)) {
          throw new Error(`${params.parent} does not exist`);
        }
        calls.push(`create:${params.name}`);
        live.set(params.name, { parent: params.parent, blocks });
      },
      update: async (_key: any, _patch: any, params: any) => {
        calls.push(`update:${params.name}`);
        live.set(params.name, { parent: params.parent, blocks });
      },
      delete: async (_key: any, state: any) => {
        const blockers = [...live].filter(
          ([, user]) => user.blocks && user.parent === state.name,
        );
        if (blockers.length > 0) {
          throw new Error(`${state.name} can't be deleted since it is in use`);
        }
        calls.push(`delete:${state.name}`);
        live.delete(state.name);
      },
    });
    const name = {
      presence: "required",
      propertyType: "param",
      primaryKey: true,
      value: v.string(),
    };
    // Cast: a resource declared without API types constrains every schema
    // key to be a key of an `any` API schema, which no named key satisfies.
    const Bus = resource({ type: "test/durable/world-bus", provider: "test" })
      .defineSchema({ name } as any)
      .defineOperations(operations(false) as any);
    // The parent can be updated, so a child is replaced only because deploy
    // deletes it before its parent.
    const defineChild = (
      type: `${string}/${string}/${string}`,
      blocksDeleteOf?: `${string}/${string}/${string}`[],
    ) =>
      resource({ type, provider: "test", blocksDeleteOf })
        .defineSchema({
          name,
          parent: {
            presence: "required",
            propertyType: "param",
            value: v.string(),
          },
        } as any)
        .defineOperations(operations(Boolean(blocksDeleteOf)) as any)
        .requireDependencies<{ parent: BaseResource }>()
        .deriveParams(({ deps }) => ({
          parent: (deps.parent.output as any).name,
        }));
    const Rule = defineChild("test/durable/world-rule", [Bus.type]);
    const Target = defineChild("test/durable/world-target", [Rule.type]);
    const Permission = defineChild("test/durable/world-permission");
    // A rule of a type that only an orphan has, so that deploy has no class
    // for it.
    const Stray = defineChild("test/durable/world-stray", [Bus.type]);
    // A mapping on a function, which does not block the delete of the
    // function.
    const Mapping = defineChild("test/durable/world-mapping");
    return {
      calls,
      live,
      failCreate,
      Bus,
      Rule,
      Target,
      Permission,
      Stray,
      Mapping,
    };
  }

  /** A bus, a rule on it, a permission on the rule, and a function with the bus name in its env. */
  function declare(
    world: ReturnType<typeof defineWorld>,
    busName: string,
    extra: (bus: BaseResource, rule: BaseResource) => BaseResource[] = () => [],
    ruleName = "rule",
  ) {
    const bus = new world.Bus("bus", { config: { name: busName } as any });
    const rule = new world.Rule("rule", {
      config: { name: ruleName } as any,
      dependencies: { parent: bus },
    });
    const permission = new world.Permission("permission", {
      config: { name: "permission" } as any,
      dependencies: { parent: rule },
    });
    const fn = new world.Permission("fn", {
      config: { name: "fn" } as any,
      dependencies: { parent: bus },
    });
    return [bus, rule, permission, fn, ...extra(bus, rule)];
  }

  const decisions = (events: ReconcilerEvent[]) =>
    Object.fromEntries(
      events
        .filter((event) => event.event === "reconciler.deploy.decision")
        .map((event: any) => [event.resourceId, event.decision]),
    );

  it("deletes the dependents that block the delete first, and creates them again after the replacement", async () => {
    const world = defineWorld();
    const resources = declare(world, "orders");
    const events: ReconcilerEvent[] = [];
    const runtime = createRuntime(resources, "replace-dependents", {
      emit: (event) => void events.push(event),
    });

    await runtime.run("deploy-1");
    resources.splice(0, resources.length, ...declare(world, "shop"));
    world.calls.length = 0;
    events.length = 0;
    await runtime.run("deploy-2");

    // The rule has the same name, so the permission is unchanged. The
    // function is updated in place.
    expect(world.calls).toEqual([
      "delete:rule",
      "delete:orders",
      "create:shop",
      "create:rule",
      "update:fn",
    ]);
    expect(decisions(events)).toEqual({
      bus: "replace",
      rule: "create",
      permission: "noop",
      fn: "update",
    });
    expect(await runtime.state.get("rule")).toMatchObject({
      params: { name: "rule", parent: "shop" },
      dependsOn: ["bus"],
    });
    expect(
      events.filter(
        (event) =>
          event.event === "reconciler.operation.lifecycle" &&
          event.operation === "delete" &&
          event.status === "success",
      ),
    ).toEqual([
      expect.objectContaining({
        resourceId: "rule",
        reason: "dependency-replaced",
        replacedDependency: "bus",
      }),
      expect.not.objectContaining({ reason: expect.anything() }),
    ]);
    runtime.close();
  });

  it("resumes after a crash that follows the removal of a dependent's record", async () => {
    const world = defineWorld();
    const resources = declare(world, "orders");
    const runtime = createRuntime(resources, "replace-dependents-crash", {
      // The key names the replaced resource, so that two replacements that
      // delete the same dependent don't share it.
      crashAfterStep: "state:delete:rule:replace:bus",
    });

    await runtime.run("deploy-1");
    resources.splice(0, resources.length, ...declare(world, "shop"));
    world.calls.length = 0;
    await expect(runtime.run("deploy-2")).rejects.toThrow(
      "simulated process crash",
    );
    expect(world.calls).toEqual(["delete:rule"]);

    await runtime.run("deploy-2");
    expect(world.calls).toEqual([
      "delete:rule",
      "delete:orders",
      "create:shop",
      "create:rule",
      "update:fn",
    ]);
    runtime.close();
  });

  it("deletes a dependent whose record has no edges, by the edges in code", async () => {
    const world = defineWorld();
    const resources = declare(world, "orders");
    const runtime = createRuntime(resources, "replace-dependents-no-edges");

    await runtime.run("deploy-1");
    removeEdges(runtime, "rule");
    resources.splice(0, resources.length, ...declare(world, "shop"));
    world.calls.length = 0;
    await runtime.run("deploy-2");

    expect(world.calls).toEqual([
      "delete:rule",
      "delete:orders",
      "create:shop",
      "create:rule",
      "update:fn",
    ]);
    runtime.close();
  });

  it("deletes the dependents that block the delete of a dependent it deletes", async () => {
    const world = defineWorld();
    const withTarget = (_bus: BaseResource, rule: BaseResource) => [
      new world.Target("target", {
        config: { name: "target" } as any,
        dependencies: { parent: rule },
      }),
    ];
    const resources = declare(world, "orders", withTarget);
    const runtime = createRuntime(resources, "replace-dependents-transitive");

    await runtime.run("deploy-1");
    resources.splice(
      0,
      resources.length,
      ...declare(world, "shop", withTarget),
    );
    world.calls.length = 0;
    await runtime.run("deploy-2");

    expect(world.calls).toEqual([
      "delete:target",
      "delete:rule",
      "delete:orders",
      "create:shop",
      "create:rule",
      "update:fn",
      "create:target",
    ]);
    runtime.close();
  });

  it("deletes a dependent that is replaced itself once", async () => {
    const world = defineWorld();
    const resources = declare(world, "orders");
    const runtime = createRuntime(resources, "replace-dependent-replaced");

    await runtime.run("deploy-1");
    resources.splice(
      0,
      resources.length,
      ...declare(world, "shop", undefined, "rule-2"),
    );
    world.calls.length = 0;
    await runtime.run("deploy-2");

    expect(world.calls).toEqual([
      "delete:rule",
      "delete:orders",
      "create:shop",
      "create:rule-2",
      "update:fn",
      "update:permission",
    ]);
    runtime.close();
  });

  it("deletes a dependent of several replaced resources once", async () => {
    const world = defineWorld();
    const declareTwo = (suffix: string) => {
      const [bus, rule, permission, fn] = declare(world, `orders${suffix}`);
      const other = new world.Bus("other", {
        config: { name: `other${suffix}` } as any,
      });
      rule!.dependOn(other);
      return [bus!, other, rule!, permission!, fn!];
    };
    const resources = declareTwo("");
    const runtime = createRuntime(resources, "replace-shared-dependent");

    await runtime.run("deploy-1");
    resources.splice(0, resources.length, ...declareTwo("-2"));
    world.calls.length = 0;
    await runtime.run("deploy-2");

    expect(world.calls).toEqual([
      "delete:rule",
      "delete:orders",
      "create:orders-2",
      "delete:other",
      "create:other-2",
      "create:rule",
      "update:fn",
    ]);
    runtime.close();
  });

  it("deletes an orphan that blocks the delete of the replaced resource before it", async () => {
    const world = defineWorld();
    const withOld = (bus: BaseResource) => [
      new world.Rule("old-rule", {
        config: { name: "old-rule" } as any,
        dependencies: { parent: bus },
      }),
    ];
    const resources = declare(world, "orders", withOld);
    const runtime = createRuntime(resources, "replace-orphan-dependent", {
      registry: createResourceRegistry([
        world.Bus,
        world.Rule,
        world.Permission,
      ]),
    });

    await runtime.run("deploy-1");
    resources.splice(0, resources.length, ...declare(world, "shop"));
    world.calls.length = 0;
    await runtime.run("deploy-2");

    expect(world.calls.slice(0, 2).sort()).toEqual([
      "delete:old-rule",
      "delete:rule",
    ]);
    expect(world.calls.slice(2)).toEqual([
      "delete:orders",
      "create:shop",
      "create:rule",
      "update:fn",
    ]);
    expect(await runtime.state.get("old-rule")).toBeUndefined();
    runtime.close();
  });

  it("treats a dependent with no registered class as not blocking the delete, so the provider refuses the delete", async () => {
    const world = defineWorld();
    const withStray = (bus: BaseResource) => [
      new world.Stray("stray", {
        config: { name: "stray" } as any,
        dependencies: { parent: bus },
      }),
    ];
    const resources = declare(world, "orders", withStray);
    const runtime = createRuntime(resources, "replace-unregistered-dependent");

    await runtime.run("deploy-1");
    resources.splice(0, resources.length, ...declare(world, "shop"));
    world.calls.length = 0;
    await expect(runtime.run("deploy-2")).rejects.toThrow(
      "orders can't be deleted since it is in use",
    );

    expect(world.calls).toEqual(["delete:rule"]);
    expect(await runtime.state.get("rule")).toBeUndefined();
    for (const id of ["bus", "permission", "stray"]) {
      expect(await runtime.state.get(id)).toBeDefined();
    }
    runtime.close();
  });

  it("replaces a resource when a dependent has no registered class, and warns about the dependent in the sweep", async () => {
    const world = defineWorld();
    const declareFn = (fnName: string, withMapping: boolean) => {
      const bus = new world.Bus("bus", { config: { name: "orders" } as any });
      const fn = new world.Permission("fn", {
        config: { name: fnName } as any,
        dependencies: { parent: bus },
      });
      const mapping = new world.Mapping("mapping", {
        config: { name: "mapping" } as any,
        dependencies: { parent: fn },
      });
      return withMapping ? [bus, fn, mapping] : [bus, fn];
    };
    const resources = declareFn("fn", true);
    const events: ReconcilerEvent[] = [];
    const runtime = createRuntime(resources, "replace-unlisted-type", {
      emit: (event) => void events.push(event),
    });

    await runtime.run("deploy-1");
    resources.splice(0, resources.length, ...declareFn("fn-2", false));
    world.calls.length = 0;
    events.length = 0;
    await runtime.run("deploy-2");

    expect(world.calls).toEqual(["delete:fn", "create:fn-2"]);
    expect(decisions(events)).toEqual({ bus: "noop", fn: "replace" });
    expect(
      events.filter(
        (event) => event.event === "reconciler.orphan-deletion.skipped",
      ),
    ).toEqual([
      expect.objectContaining({
        resourceId: "mapping",
        resourceType: world.Mapping.type,
      }),
    ]);
    expect(await runtime.state.get("mapping")).toBeDefined();
    runtime.close();
  });

  it("fails at the provider and keeps state when a replaced bus has an orphan rule with no registered class", async () => {
    const world = defineWorld();
    const resources = declare(world, "orders");
    const runtime = createRuntime(resources, "replace-unlisted-bus");
    const busAndFn = () => {
      const [bus, , , fn] = declare(world, "shop");
      return [bus!, fn!];
    };

    await runtime.run("deploy-1");
    // No resource in code is a rule, so the rule has no registered class,
    // and deploy deletes the bus without deleting the rule first.
    resources.splice(0, resources.length, ...busAndFn());
    world.calls.length = 0;
    await expect(runtime.run("deploy-2")).rejects.toThrow(
      "orders can't be deleted since it is in use",
    );
    expect(world.calls).toEqual([]);
    expect(await runtime.state.get("bus")).toMatchObject({
      params: { name: "orders" },
    });
    for (const id of ["rule", "permission", "fn"]) {
      expect(await runtime.state.get(id)).toBeDefined();
    }

    // A re-run fails in the same way.
    await durable.clearDeploymentHold({
      storeClient: runtime.storeClient,
      deploymentId: "replace-unlisted-bus",
      fromExecutionId: "deploy-2",
    });
    await expect(runtime.run("deploy-3")).rejects.toThrow(
      "orders can't be deleted since it is in use",
    );
    expect(world.calls).toEqual([]);

    // With the rule declared again, the rename deletes the rule first.
    await durable.clearDeploymentHold({
      storeClient: runtime.storeClient,
      deploymentId: "replace-unlisted-bus",
      fromExecutionId: "deploy-3",
    });
    resources.splice(0, resources.length, ...declare(world, "shop"));
    await runtime.run("deploy-4");
    expect(world.calls).toEqual([
      "delete:rule",
      "delete:orders",
      "create:shop",
      "create:rule",
      "update:fn",
    ]);
    runtime.close();
  });

  it("creates the dependents on the next deploy when one fails to be created again", async () => {
    const world = defineWorld();
    const resources = declare(world, "orders");
    const runtime = createRuntime(resources, "replace-dependents-failed");

    await runtime.run("deploy-1");
    resources.splice(0, resources.length, ...declare(world, "shop"));
    world.failCreate.add("rule");
    world.calls.length = 0;
    await expect(runtime.run("deploy-2")).rejects.toThrow(
      "create rule rejected",
    );
    expect(await runtime.state.get("bus")).toMatchObject({
      params: { name: "shop" },
    });
    expect(await runtime.state.get("rule")).toBeUndefined();

    await durable.clearDeploymentHold({
      storeClient: runtime.storeClient,
      deploymentId: "replace-dependents-failed",
      fromExecutionId: "deploy-2",
    });
    world.failCreate.clear();
    await runtime.run("deploy-3");

    expect(world.calls).toEqual([
      "delete:rule",
      "delete:orders",
      "create:shop",
      "create:rule",
      "update:fn",
    ]);
    expect(Object.fromEntries(world.live)).toEqual({
      shop: { parent: undefined, blocks: false },
      rule: { parent: "shop", blocks: true },
      permission: { parent: "rule", blocks: false },
      fn: { parent: "shop", blocks: false },
    });
    runtime.close();
  });

  it("resumes after a crash between the deletes of the dependents", async () => {
    const world = defineWorld();
    const withTarget = (_bus: BaseResource, rule: BaseResource) => [
      new world.Target("target", {
        config: { name: "target" } as any,
        dependencies: { parent: rule },
      }),
    ];
    const resources = declare(world, "orders", withTarget);
    const runtime = createRuntime(resources, "replace-dependents-resume", {
      crashAfterStep:
        "notation:deploy:bus:replace:dependents:target:delete:remote:attempt:0",
    });

    await runtime.run("deploy-1");
    resources.splice(
      0,
      resources.length,
      ...declare(world, "shop", withTarget),
    );
    world.calls.length = 0;
    await expect(runtime.run("deploy-2")).rejects.toThrow(
      "simulated process crash",
    );
    expect(world.calls).toEqual(["delete:target"]);

    await runtime.run("deploy-2");
    expect(world.calls).toEqual([
      "delete:target",
      "delete:rule",
      "delete:orders",
      "create:shop",
      "create:rule",
      "update:fn",
      "create:target",
    ]);
    runtime.close();
  });

  it("leaves in place the dependents that do not block the delete", async () => {
    const world = defineWorld();
    const declareBus = (busName: string) => {
      const bus = new world.Bus("bus", { config: { name: busName } as any });
      const fn = new world.Permission("fn", {
        config: { name: "fn" } as any,
        dependencies: { parent: bus },
      });
      return [bus, fn];
    };
    const resources = declareBus("orders");
    const events: ReconcilerEvent[] = [];
    const runtime = createRuntime(resources, "replace-keeps-dependents", {
      emit: (event) => void events.push(event),
    });

    await runtime.run("deploy-1");
    resources.splice(0, resources.length, ...declareBus("shop"));
    world.calls.length = 0;
    await runtime.run("deploy-2");

    expect(world.calls).toEqual(["delete:orders", "create:shop", "update:fn"]);
    expect(await runtime.state.get("fn")).toMatchObject({
      params: { name: "fn", parent: "shop" },
    });
    expect(
      events.filter(
        (event) =>
          event.event === "reconciler.operation.lifecycle" &&
          "reason" in event &&
          event.reason === "dependency-replaced",
      ),
    ).toEqual([]);
    runtime.close();
  });

  it("does not list state to replace a resource whose type no class lists in blocksDeleteOf", async () => {
    const world = defineWorld();
    // The rule lists the bus type, so a class in code blocks the delete of
    // a bus, but none blocks the delete of a function.
    const declareTree = (fnName: string) => {
      const bus = new world.Bus("bus", { config: { name: "orders" } as any });
      const fn = new world.Permission("fn", {
        config: { name: fnName } as any,
        dependencies: { parent: bus },
      });
      const mapping = new world.Mapping("mapping", {
        config: { name: "mapping" } as any,
        dependencies: { parent: fn },
      });
      const rule = new world.Rule("rule", {
        config: { name: "rule" } as any,
        dependencies: { parent: bus },
      });
      return [bus, fn, mapping, rule];
    };
    const resources = declareTree("fn");
    const runtime = createRuntime(resources, "replace-skips-listing");

    await runtime.run("deploy-1");
    const values = vi.spyOn(runtime.state, "values");
    await runtime.run("deploy-1b");
    const callsWithoutReplacement = values.mock.calls.length;
    values.mockClear();
    resources.splice(0, resources.length, ...declareTree("fn-2"));
    world.calls.length = 0;
    await runtime.run("deploy-2");

    expect(world.calls).toEqual(["delete:fn", "create:fn-2", "update:mapping"]);
    expect(values.mock.calls.length).toBe(callsWithoutReplacement);
    runtime.close();
  });

  it("in a dry run, deletes nothing", async () => {
    const world = defineWorld();
    const withOld = (bus: BaseResource) => [
      new world.Rule("old-rule", {
        config: { name: "old-rule" } as any,
        dependencies: { parent: bus },
      }),
    ];
    const resources = declare(world, "orders", withOld);
    const options = {
      dryRun: false,
      registry: createResourceRegistry([
        world.Bus,
        world.Rule,
        world.Permission,
      ]),
      emit: (event: ReconcilerEvent) => void events.push(event),
    };
    const events: ReconcilerEvent[] = [];
    const runtime = createRuntime(
      resources,
      "replace-dependents-dry-run",
      options,
    );

    await runtime.run("deploy-1");
    resources.splice(0, resources.length, ...declare(world, "shop"));
    options.dryRun = true;
    world.calls.length = 0;
    events.length = 0;
    await runtime.run("dry-run");

    expect(world.calls).toEqual([]);
    // A dry run keeps the records it would delete, and does not create the
    // new bus, so the rule and the function read the old bus's name.
    expect(decisions(events)).toEqual({
      bus: "replace",
      rule: "noop",
      permission: "noop",
      fn: "noop",
    });
    // The sweep reports the delete of the orphan a second time.
    expect(
      events
        .filter(
          (event) =>
            event.event === "reconciler.operation.lifecycle" &&
            event.operation === "delete" &&
            event.status === "dry-run",
        )
        .map((event: any) => event.resourceId)
        .sort(),
    ).toEqual(["bus", "old-rule", "old-rule", "rule"]);
    expect(await runtime.state.get("rule")).toMatchObject({
      params: { name: "rule", parent: "orders" },
    });
    expect(await runtime.state.get("old-rule")).toBeDefined();
    runtime.close();
  });
});

describe("contributions and output refs", () => {
  it("deploys a contributor first and fills in its output refs", async () => {
    const created: Record<string, unknown>[] = [];
    const Queue = resource({ type: "test/durable/queue", provider: "test" })
      .defineSchema({
        name: {
          presence: "required",
          propertyType: "param",
          primaryKey: true,
          value: v.string(),
        },
        arn: {
          presence: "required",
          propertyType: "computed",
          value: v.string(),
        },
      } as any)
      .defineOperations({
        create: async (params: any) => {
          created.push(params);
          return { arn: `arn:${params.name}` } as any;
        },
        delete: async () => undefined,
      });
    const Fn = resource({ type: "test/durable/function", provider: "test" })
      .defineSchema({
        name: {
          presence: "required",
          propertyType: "param",
          primaryKey: true,
          value: v.string(),
        },
        env: {
          value: v.record(v.string(), v.string()),
          presence: "optional",
          propertyType: "param",
          collect: mergeContributions,
        },
      } as any)
      .defineOperations({
        create: async (params: any) => {
          created.push(params);
        },
        delete: async () => undefined,
      });
    // Listed before the queue, so only the implied edge orders the deploy.
    const fn = new Fn("fn", { config: { name: "f" } as any });
    const queue = new Queue("queue", { config: { name: "orders" } as any });
    fn.contribute({ env: { QUEUE: (queue as any).outputRef("arn") } } as any);
    const runtime = createRuntime([fn, queue], "contributions");

    await runtime.run("contributions-execution");
    expect(created).toEqual([
      { name: "orders" },
      { name: "f", env: { QUEUE: "arn:orders" } },
    ]);
    expect(await runtime.state.get("fn")).toMatchObject({
      params: { name: "f", env: { QUEUE: "arn:orders" } },
      dependsOn: ["queue"],
    });
    runtime.close();
  });

  it("deploys the deps of a function contribution first and runs it with their outputs", async () => {
    const created: Record<string, unknown>[] = [];
    const Queue = resource({ type: "test/durable/queue", provider: "test" })
      .defineSchema({
        name: {
          presence: "required",
          propertyType: "param",
          primaryKey: true,
          value: v.string(),
        },
        arn: {
          presence: "required",
          propertyType: "computed",
          value: v.string(),
        },
      } as any)
      .defineOperations({
        create: async (params: any) => {
          created.push(params);
          return { arn: `arn:${params.name}` } as any;
        },
        delete: async () => undefined,
      });
    const Fn = resource({ type: "test/durable/function", provider: "test" })
      .defineSchema({
        name: {
          presence: "required",
          propertyType: "param",
          primaryKey: true,
          value: v.string(),
        },
        env: {
          value: v.record(v.string(), v.string()),
          presence: "optional",
          propertyType: "param",
          collect: mergeContributions,
        },
      } as any)
      .defineOperations({
        create: async (params: any) => {
          created.push(params);
        },
        delete: async () => undefined,
      });
    // Listed before the queue, so only the declared deps order the deploy.
    const fn = new Fn("fn", { config: { name: "f" } as any });
    const queue = new Queue("queue", { config: { name: "orders" } as any });
    fn.contribute(
      ({ deps }) => ({ env: { QUEUE: `${(deps.queue.output as any).arn}/*` } }),
      { deps: { queue } },
    );
    const runtime = createRuntime([fn, queue], "function-contributions");

    await runtime.run("function-contributions-execution");
    expect(created).toEqual([
      { name: "orders" },
      { name: "f", env: { QUEUE: "arn:orders/*" } },
    ]);
    expect(await runtime.state.get("fn")).toMatchObject({
      params: { name: "f", env: { QUEUE: "arn:orders/*" } },
      dependsOn: ["queue"],
    });
    runtime.close();
  });
});

describe("value validation at deploy", () => {
  type RoleApi = {
    Key: { name: string };
    CreateParams: { name: string; boundary?: string };
    UpdateParams: { boundary?: string };
    ReadResult: { arn: string };
  };
  type FnApi = {
    Key: { name: string };
    CreateParams: { name: string; memory: number; role: string };
    UpdateParams: { memory: number; role: string };
    ReadResult: {};
  };

  function defineRole(
    operations: {
      create?: () => Promise<any>;
      read?: () => Promise<any>;
      update?: () => Promise<void>;
    } = {},
  ) {
    return resource<RoleApi>({
      type: "test/durable/validated-role",
      provider: "test",
    })
      .defineSchema({
        name: {
          propertyType: "param",
          presence: "required",
          value: v.string(),
          primaryKey: true,
          immutable: true,
        },
        boundary: {
          propertyType: "param",
          presence: "optional",
          value: v.string(),
          immutable: true,
        },
        arn: {
          propertyType: "computed",
          presence: "required",
          value: v.string(),
        },
      })
      .defineOperations({
        create: operations.create ?? (async () => undefined),
        read: operations.read,
        update: operations.update ?? (async () => undefined),
        delete: async () => undefined,
      });
  }

  function defineFn(
    create: () => Promise<void>,
    memory: () => number,
    roleValue: v.GenericSchema<string> = v.string(),
    update?: () => Promise<void>,
  ) {
    return resource<FnApi>({
      type: "test/durable/validated-fn",
      provider: "test",
    })
      .defineSchema({
        name: {
          propertyType: "param",
          presence: "required",
          value: v.string(),
          primaryKey: true,
          immutable: true,
        },
        memory: {
          propertyType: "param",
          presence: "required",
          value: v.pipe(v.number(), v.integer()),
        },
        role: {
          propertyType: "param",
          presence: "required",
          value: roleValue,
        },
      })
      .defineOperations({
        create,
        ...(update ? { update } : {}),
        delete: async () => undefined,
      })
      .requireDependencies<{ role: BaseResource }>()
      .deriveParams(() => ({ memory: memory() }));
  }

  it("checks every known value before the first change", async () => {
    const createRole = vi.fn(async () => ({ arn: "arn:role" }));
    const createFn = vi.fn(async () => undefined);
    const Role = defineRole({ create: createRole });
    const Fn = defineFn(createFn, () => Number(undefined));
    const role = new Role("role", { config: { name: "role" } });
    const fn = new Fn("fn", {
      config: { name: "fn", role: role.outputRef("arn") },
      dependencies: { role },
    });
    const runtime = createRuntime([role, fn], "validate-known");

    const error = await runtime.run("validate-known-execution").catch((e) => e);

    expect(ValueValidationError.is(error)).toBe(true);
    expect(error).toMatchObject({
      resourceId: "fn",
      field: "memory",
      point: "deploy",
    });
    expect(createRole).not.toHaveBeenCalled();
    expect(await runtime.state.values()).toHaveLength(0);
    runtime.close();
  });

  it("checks values from outputs in state before the first change", async () => {
    let strict = false;
    const createRole = vi.fn(async () => ({ arn: "arn:role" }));
    const Role = defineRole({ create: createRole });
    const Fn = resource<FnApi>({
      type: "test/durable/validated-fn",
      provider: "test",
    })
      .defineSchema({
        name: {
          propertyType: "param",
          presence: "required",
          value: v.string(),
          primaryKey: true,
          immutable: true,
        },
        memory: {
          propertyType: "param",
          presence: "required",
          value: v.pipe(v.number(), v.integer()),
        },
        role: {
          propertyType: "param",
          presence: "required",
          value: v.string(),
        },
      })
      .defineOperations({
        create: async () => undefined,
        delete: async () => undefined,
      })
      .requireDependencies<{ role: BaseResource }>()
      .deriveParams(({ deps }) => {
        const { arn } = deps.role.output as { arn?: string };
        return { memory: strict && arn === "arn:role" ? 1.5 : 128 };
      });
    const resources: BaseResource[] = [];
    const runtime = createRuntime(resources, "validate-state-outputs");
    const declare = (boundary?: string) => {
      const role = new Role("role", { config: { name: "role", boundary } });
      const fn = new Fn("fn", {
        config: { name: "fn", role: role.outputRef("arn") },
        dependencies: { role },
      });
      resources.splice(0, resources.length, role, fn);
    };
    declare();
    await runtime.run("validate-state-outputs-1");

    strict = true;
    declare("arn:boundary");
    const error = await runtime.run("validate-state-outputs-2").catch((e) => e);

    expect(error).toMatchObject({
      name: "ValueValidationError",
      resourceId: "fn",
      field: "memory",
      point: "deploy",
    });
    expect(createRole).toHaveBeenCalledOnce();
    expect(await runtime.state.get("role")).toMatchObject({
      params: { name: "role" },
    });
    runtime.close();
  });

  it("checks a value from another resource's output just before its operation", async () => {
    const createFn = vi.fn(async () => undefined);
    const Role = defineRole({ create: async () => ({ arn: "role-arn" }) });
    const Fn = defineFn(
      createFn,
      () => 128,
      v.pipe(v.string(), v.startsWith("arn:")),
    );
    const role = new Role("role", { config: { name: "role" } });
    const fn = new Fn("fn", {
      config: { name: "fn", role: role.outputRef("arn") },
      dependencies: { role },
    });
    const runtime = createRuntime([role, fn], "validate-output");

    const error = await runtime
      .run("validate-output-execution")
      .catch((e) => e);

    expect(error).toMatchObject({
      name: "ValueValidationError",
      resourceId: "fn",
      field: "role",
      point: "deploy",
    });
    expect(createFn).not.toHaveBeenCalled();
    expect(await runtime.state.get("role")).toMatchObject({
      output: { arn: "role-arn" },
    });
    expect(await runtime.state.get("fn")).toBeUndefined();
    runtime.close();
  });

  it("fails on a malformed read rather than comparing it", async () => {
    let remote: Record<string, unknown> = {
      name: "role",
      boundary: "arn:boundary",
      arn: "arn:role",
    };
    const update = vi.fn(async () => undefined);
    const Role = defineRole({
      create: async () => ({ arn: "arn:role" }),
      read: async () => remote,
      update,
    });
    const runtime = createRuntime(
      [
        new Role("role", {
          config: { name: "role", boundary: "arn:boundary" },
        }),
      ],
      "validate-read",
      { driftDetection: true },
    );
    await runtime.run("validate-read-1");

    remote = {
      ...remote,
      boundary: { type: "Policy", arn: "arn:boundary" },
    };
    const error = await runtime.run("validate-read-2").catch((e) => e);

    expect(error).toMatchObject({
      name: "ValueValidationError",
      resourceId: "role",
      field: "boundary",
      point: "read",
    });
    expect(error.message).toMatch(
      /^The read of role \(test\/durable\/validated-role\) returned an invalid boundary/,
    );
    expect(update).not.toHaveBeenCalled();
    expect(await runtime.state.get("role")).toMatchObject({
      version: 1,
      params: { boundary: "arn:boundary" },
    });
    runtime.close();
  });

  it("records the resource, then fails, when the read after create is malformed", async () => {
    const create = vi.fn(async () => ({ arn: "arn:role" }));
    const Role = defineRole({
      create,
      read: async () => ({ name: "role", boundary: 7, arn: "arn:role" }),
    });
    const runtime = createRuntime(
      [new Role("role", { config: { name: "role" } })],
      "validate-create-read",
    );

    const error = await runtime.run("validate-create-read-1").catch((e) => e);

    expect(error).toMatchObject({
      name: "ValueValidationError",
      resourceId: "role",
      field: "boundary",
      point: "read",
    });
    expect(create).toHaveBeenCalledOnce();
    expect(await runtime.state.get("role")).toMatchObject({
      lastOperation: "create",
      params: { name: "role" },
      output: { name: "role", arn: "arn:role" },
    });
    runtime.close();
  });

  it("records the update, then fails, when the read after update is malformed", async () => {
    let remote: Record<string, unknown> = { name: "role", arn: "arn:role" };
    const update = vi.fn(async () => undefined);
    const Fn = resource<{
      Key: { name: string };
      CreateParams: { name: string; memory: number };
      UpdateParams: { memory: number };
      ReadResult: { arn: string };
    }>({ type: "test/durable/validated-updated", provider: "test" })
      .defineSchema({
        name: {
          propertyType: "param",
          presence: "required",
          value: v.string(),
          primaryKey: true,
          immutable: true,
        },
        memory: {
          propertyType: "param",
          presence: "required",
          value: v.number(),
        },
        arn: {
          propertyType: "computed",
          presence: "required",
          value: v.string(),
        },
      })
      .defineOperations({
        create: async () => undefined,
        read: async () => remote as any,
        update,
        delete: async () => undefined,
      });
    const resources: BaseResource[] = [
      new Fn("fn", { config: { name: "fn", memory: 128 } }),
    ];
    const runtime = createRuntime(resources, "validate-update-read");
    remote = { name: "fn", memory: 128, arn: "arn:fn" };
    await runtime.run("validate-update-read-1");

    resources[0] = new Fn("fn", { config: { name: "fn", memory: 256 } });
    remote = { name: "fn", memory: "256", arn: "arn:fn" };
    const error = await runtime.run("validate-update-read-2").catch((e) => e);

    expect(error).toMatchObject({
      name: "ValueValidationError",
      field: "memory",
      point: "read",
    });
    expect(update).toHaveBeenCalledOnce();
    expect(await runtime.state.get("fn")).toMatchObject({
      lastOperation: "update",
      params: { memory: 256 },
      output: { memory: 256, arn: "arn:fn" },
    });
    runtime.close();
  });

  it("records the resource, then fails, when create returns a param", async () => {
    const Role = defineRole({
      create: async () => ({ name: "role", arn: "arn:role" }) as any,
    });
    const runtime = createRuntime(
      [new Role("role", { config: { name: "role" } })],
      "validate-create-result",
    );

    const error = await runtime.run("validate-create-result-1").catch((e) => e);

    expect(SchemaStructureError.is(error)).toBe(true);
    expect(error.message).toMatch(
      /create returned fields that are not computed in its schema: name$/,
    );
    expect(await runtime.state.get("role")).toMatchObject({
      output: { arn: "arn:role" },
    });
    runtime.close();
  });

  it("records the resource, then fails, when a create result value is invalid", async () => {
    const Role = defineRole({ create: async () => ({ arn: 42 }) as any });
    const runtime = createRuntime(
      [new Role("role", { config: { name: "role" } })],
      "validate-create-value",
    );

    const error = await runtime.run("validate-create-value-1").catch((e) => e);

    expect(error).toMatchObject({
      name: "ValueValidationError",
      resourceId: "role",
      field: "arn",
      point: "create",
    });
    expect(error.message).toMatch(
      /^The create of role \(test\/durable\/validated-role\) returned an invalid arn/,
    );
    expect(await runtime.state.get("role")).toMatchObject({
      lastOperation: "create",
      output: { arn: 42 },
    });
    runtime.close();
  });

  it("checks a computed key from create before the read uses it", async () => {
    const read = vi.fn(async (key: { id: unknown }) => {
      if (typeof key.id !== "string") throw new Error("malformed key");
      return { id: key.id };
    });
    const Queue = resource<{
      Key: { id: string };
      CreateParams: { name: string };
      UpdateParams: {};
      ReadResult: {};
    }>({ type: "test/durable/validated-queue", provider: "test" })
      .defineSchema({
        id: {
          propertyType: "computed",
          presence: "required",
          value: v.string(),
          primaryKey: true,
        },
        name: {
          propertyType: "param",
          presence: "required",
          value: v.string(),
          immutable: true,
        },
      })
      .defineOperations({
        create: async () => ({ id: 42 }) as any,
        read,
        delete: async () => undefined,
      });
    const runtime = createRuntime(
      [new Queue("queue", { config: { name: "queue" } })],
      "validate-create-key",
    );

    const error = await runtime.run("validate-create-key-1").catch((e) => e);

    expect(error).toMatchObject({
      name: "ValueValidationError",
      field: "id",
      point: "create",
    });
    expect(read).not.toHaveBeenCalled();
    expect(await runtime.state.get("queue")).toMatchObject({
      lastOperation: "create",
      output: { id: 42 },
    });
    runtime.close();
  });

  it("records the resource, then fails, when a required output is missing", async () => {
    const Role = defineRole();
    const runtime = createRuntime(
      [new Role("role", { config: { name: "role" } })],
      "validate-outputs",
    );

    const error = await runtime.run("validate-outputs-1").catch((e) => e);

    expect(error).toMatchObject({
      name: "SchemaStructureError",
      fields: ["arn"],
    });
    expect(await runtime.state.get("role")).toMatchObject({ id: "role" });
    runtime.close();
  });

  it("reads a recorded resource again when a required output is missing", async () => {
    let arn: string | undefined;
    const Role = defineRole({ read: async () => ({ arn }) });
    const runtime = createRuntime(
      [new Role("role", { config: { name: "role" } })],
      "recover-outputs",
    );
    await runtime.run("recover-outputs-1").catch(() => {});

    const error = await runtime.run("recover-outputs-2").catch((e) => e);
    expect(error).toMatchObject({
      name: "SchemaStructureError",
      fields: ["arn"],
    });

    arn = "arn:role";
    await runtime.run("recover-outputs-3");
    expect(await runtime.state.get("role")).toMatchObject({
      output: { arn: "arn:role" },
    });
    runtime.close();
  });

  it("fills in a required output missing from state before a dependent uses it", async () => {
    let arn: string | undefined;
    const createFn = vi.fn(async () => undefined);
    const Role = defineRole({ read: async () => ({ arn }) });
    const Fn = defineFn(createFn, () => 128);
    const role = new Role("role", { config: { name: "role" } });
    const fn = new Fn("fn", {
      config: { name: "fn", role: role.outputRef("arn") },
      dependencies: { role },
    });
    const runtime = createRuntime([role, fn], "dependent-outputs");
    const error = await runtime.run("dependent-outputs-1").catch((e) => e);
    expect(error).toMatchObject({
      name: "SchemaStructureError",
      fields: ["arn"],
    });
    expect(await runtime.state.get("role")).toMatchObject({ id: "role" });
    expect(createFn).not.toHaveBeenCalled();

    arn = "arn:role";
    await runtime.run("dependent-outputs-2");

    expect(await runtime.state.get("fn")).toMatchObject({
      params: { name: "fn", memory: 128, role: "arn:role" },
    });
    runtime.close();
  });

  it("leaves a dependent unchanged once a missing output is filled in with the value it already has", async () => {
    // The role's type had no `arn` output when the first deploy ran.
    const OldRole = resource<{
      Key: { name: string };
      CreateParams: { name: string };
      UpdateParams: {};
      ReadResult: {};
    }>({
      type: "test/durable/validated-role",
      provider: "test",
    })
      .defineSchema({
        name: {
          propertyType: "param",
          presence: "required",
          value: v.string(),
          primaryKey: true,
          immutable: true,
        },
      })
      .defineOperations({
        create: async () => undefined,
        delete: async () => undefined,
      });
    const createFn = vi.fn(async () => undefined);
    const updateFn = vi.fn(async () => undefined);
    const Fn = defineFn(createFn, () => 128, v.string(), updateFn);
    const oldRole = new OldRole("role", { config: { name: "role" } });
    const resources: BaseResource[] = [
      oldRole,
      new Fn("fn", {
        config: { name: "fn", role: "arn:role" },
        dependencies: { role: oldRole },
      }),
    ];
    const runtime = createRuntime(resources, "recovered-dependent");
    await runtime.run("recovered-dependent-1");
    expect((await runtime.state.get("role"))?.output).not.toHaveProperty("arn");

    const Role = defineRole({ read: async () => ({ arn: "arn:role" }) });
    const role = new Role("role", { config: { name: "role" } });
    resources.splice(
      0,
      2,
      role,
      new Fn("fn", {
        config: { name: "fn", role: role.outputRef("arn") },
        dependencies: { role },
      }),
    );
    await runtime.run("recovered-dependent-2");

    expect(await runtime.state.get("role")).toMatchObject({
      output: { arn: "arn:role" },
    });
    expect(createFn).toHaveBeenCalledOnce();
    expect(updateFn).not.toHaveBeenCalled();
    expect(await runtime.state.get("fn")).toMatchObject({
      lastOperation: "create",
      params: { name: "fn", memory: 128, role: "arn:role" },
    });
    runtime.close();
  });

  it("fails every deploy while a resource with no read lacks a required output", async () => {
    const Role = defineRole();
    const runtime = createRuntime(
      [new Role("role", { config: { name: "role" } })],
      "missing-outputs",
    );
    await runtime.run("missing-outputs-1").catch(() => {});

    const error = await runtime.run("missing-outputs-2").catch((e) => e);

    expect(error).toMatchObject({
      name: "SchemaStructureError",
      fields: ["arn"],
    });
    expect(error.message).toContain("The resource's type has no read");
    runtime.close();
  });

  it("replaces a resource with no read that lacks a required output, and records the output", async () => {
    let arn: string | undefined;
    const Role = defineRole({ create: async () => ({ arn }) });
    const resources: BaseResource[] = [
      new Role("role", { config: { name: "role" } }),
    ];
    const runtime = createRuntime(resources, "replace-missing-outputs");
    await runtime.run("replace-missing-outputs-1").catch(() => {});
    expect((await runtime.state.get("role"))?.output.arn).toBeUndefined();

    arn = "arn:role";
    resources.splice(
      0,
      1,
      new Role("role", { config: { name: "role", boundary: "b" } }),
    );
    await runtime.run("replace-missing-outputs-2");

    expect(await runtime.state.get("role")).toMatchObject({
      params: { name: "role", boundary: "b" },
      output: { arn: "arn:role" },
    });
    runtime.close();
  });

  it("replaces a resource with no read that lacks a required output when deploy deletes it before a replaced dependency", async () => {
    let policyArn: string | undefined;
    const Role = defineRole({ create: async () => ({ arn: "arn:role" }) });
    // Blocks the delete of its role, so deploy deletes it before it replaces
    // the role, and creates it again.
    const Policy = resource<{
      Key: { name: string };
      CreateParams: { name: string; role: string };
      UpdateParams: { role: string };
      ReadResult: { arn: string };
    }>({
      type: "test/durable/unread-policy",
      provider: "test",
      blocksDeleteOf: [Role.type],
    })
      .defineSchema({
        name: {
          propertyType: "param",
          presence: "required",
          value: v.string(),
          primaryKey: true,
          immutable: true,
        },
        role: {
          propertyType: "param",
          presence: "required",
          value: v.string(),
        },
        arn: {
          propertyType: "computed",
          presence: "required",
          value: v.string(),
        },
      })
      .defineOperations({
        create: async () => ({ arn: policyArn }) as any,
        update: async () => undefined,
        delete: async () => undefined,
      });
    const resources: BaseResource[] = [];
    const declare = (boundary?: string) => {
      const role = new Role("role", { config: { name: "role", boundary } });
      const policy = new Policy("policy", {
        config: { name: "policy", role: role.outputRef("arn") },
      });
      resources.splice(0, resources.length, role, policy);
    };
    declare();
    const runtime = createRuntime(resources, "cascade-missing-outputs");
    await runtime.run("cascade-missing-outputs-1").catch(() => {});
    expect((await runtime.state.get("policy"))?.output.arn).toBeUndefined();

    policyArn = "arn:policy";
    declare("b");
    await runtime.run("cascade-missing-outputs-2");

    expect(await runtime.state.get("policy")).toMatchObject({
      output: { arn: "arn:policy" },
    });
    runtime.close();
  });

  // A type with no read, whose `target` param is immutable when `immutable`
  // is set.
  function defineUnreadAttachment(
    create: () => Promise<any>,
    update: () => Promise<void>,
    immutable = false,
  ) {
    return resource<{
      Key: { name: string };
      CreateParams: { name: string; target: string };
      UpdateParams: { target: string };
      ReadResult: { arn: string };
    }>({
      type: "test/durable/unread-attachment",
      provider: "test",
    })
      .defineSchema({
        name: {
          propertyType: "param",
          presence: "required",
          value: v.string(),
          primaryKey: true,
          immutable: true,
        },
        target: {
          propertyType: "param",
          presence: "required",
          value: v.string(),
          ...(immutable ? { immutable: true as const } : {}),
        },
        arn: {
          propertyType: "computed",
          presence: "required",
          value: v.string(),
        },
      })
      .defineOperations({
        create,
        update,
        delete: async () => undefined,
      });
  }

  it("fails before the update of a resource with no read that lacks a required output", async () => {
    const updateFn = vi.fn(async () => undefined);
    const Attachment = defineUnreadAttachment(async () => undefined, updateFn);
    const resources: BaseResource[] = [
      new Attachment("attachment", {
        config: { name: "attachment", target: "a" },
      }),
    ];
    const runtime = createRuntime(resources, "update-missing-outputs");
    await runtime.run("update-missing-outputs-1").catch(() => {});
    expect((await runtime.state.get("attachment"))?.output.arn).toBeUndefined();

    resources.splice(
      0,
      1,
      new Attachment("attachment", {
        config: { name: "attachment", target: "b" },
      }),
    );
    const error = await runtime.run("update-missing-outputs-2").catch((e) => e);

    expect(error).toMatchObject({
      name: "SchemaStructureError",
      fields: ["arn"],
    });
    expect(error.message).toContain("The resource's type has no read");
    expect(updateFn).not.toHaveBeenCalled();
    runtime.close();
  });

  it("replaces a resource with no read that lacks a required output when an immutable param takes a replaced dependency's output", async () => {
    let roleArn = "arn:role-1";
    let attachmentArn: string | undefined;
    const Role = defineRole({ create: async () => ({ arn: roleArn }) });
    const Attachment = defineUnreadAttachment(
      async () => ({ arn: attachmentArn }),
      async () => undefined,
      true,
    );
    const resources: BaseResource[] = [];
    const declare = (boundary?: string) => {
      const role = new Role("role", { config: { name: "role", boundary } });
      const attachment = new Attachment("attachment", {
        config: { name: "attachment", target: role.outputRef("arn") },
      });
      resources.splice(0, resources.length, role, attachment);
    };
    declare();
    const runtime = createRuntime(resources, "dependent-missing-outputs");
    await runtime.run("dependent-missing-outputs-1").catch(() => {});
    expect((await runtime.state.get("attachment"))?.output.arn).toBeUndefined();

    roleArn = "arn:role-2";
    attachmentArn = "arn:attachment";
    declare("b");
    await runtime.run("dependent-missing-outputs-2");

    expect(await runtime.state.get("attachment")).toMatchObject({
      params: { name: "attachment", target: "arn:role-2" },
      output: { arn: "arn:attachment" },
    });
    runtime.close();
  });

  // Pins a partial apply on purpose. A check before any change would need
  // deploy's decision, which isn't known until deploy reaches the resource,
  // so it would fail deploys that succeed. See validateKnownParams in
  // durable/deploy.ts.
  it("fails at a resource with no read that lacks a required output, after it deploys the resources before it", async () => {
    const Role = defineRole({ create: async () => ({ arn: "arn:role" }) });
    const Attachment = defineUnreadAttachment(
      async () => undefined,
      async () => undefined,
    );
    const resources: BaseResource[] = [];
    const declare = (withOther: boolean) => {
      const role = new Role("role", { config: { name: "role" } });
      const attachment = new Attachment("attachment", {
        config: { name: "attachment", target: role.outputRef("arn") },
      });
      const other = new Role("other", { config: { name: "other" } });
      resources.splice(
        0,
        resources.length,
        ...(withOther ? [role, attachment, other] : [role, attachment]),
      );
    };
    declare(false);
    const runtime = createRuntime(resources, "partial-missing-outputs");
    await runtime.run("partial-missing-outputs-1").catch(() => {});
    expect((await runtime.state.get("attachment"))?.output.arn).toBeUndefined();

    declare(true);
    const error = await runtime
      .run("partial-missing-outputs-2")
      .catch((e) => e);

    expect(error).toMatchObject({
      name: "SchemaStructureError",
      fields: ["arn"],
    });
    expect(error.message).toContain("The resource's type has no read");
    expect(await runtime.state.get("other")).toMatchObject({
      output: { arn: "arn:role" },
    });
    runtime.close();
  });

  it("fails when a possible replace of a resource with no read that lacks a required output ends as noop", async () => {
    const Role = defineRole({ create: async () => ({ arn: "arn:role" }) });
    const createFn = vi.fn(async () => undefined);
    const Attachment = defineUnreadAttachment(
      createFn,
      async () => undefined,
      true,
    );
    const resources: BaseResource[] = [];
    const declare = (boundary?: string) => {
      const role = new Role("role", { config: { name: "role", boundary } });
      const attachment = new Attachment("attachment", {
        config: { name: "attachment", target: role.outputRef("arn") },
      });
      resources.splice(0, resources.length, role, attachment);
    };
    declare();
    const runtime = createRuntime(resources, "possible-replace-noop");
    await runtime.run("possible-replace-noop-1").catch(() => {});
    expect((await runtime.state.get("attachment"))?.output.arn).toBeUndefined();

    declare("b");
    const error = await runtime.run("possible-replace-noop-2").catch((e) => e);

    expect(error).toMatchObject({
      name: "SchemaStructureError",
      fields: ["arn"],
    });
    expect(error.message).toContain("The resource's type has no read");
    expect(await runtime.state.get("role")).toMatchObject({
      params: { name: "role", boundary: "b" },
    });
    expect(createFn).toHaveBeenCalledOnce();
    runtime.close();
  });

  it("deletes an orphan whose recorded config no longer passes its validator", async () => {
    let strict = false;
    const deleteSpy = vi.fn(async () => undefined);
    const Orphan = resource<{
      Key: { name: string };
      CreateParams: { name: string };
      UpdateParams: {};
      ReadResult: {};
    }>({ type: "test/durable/validated-orphan", provider: "test" })
      .defineSchema({
        name: {
          propertyType: "param",
          presence: "required",
          value: v.pipe(
            v.string(),
            v.check(() => !strict, "Rejected"),
          ),
          primaryKey: true,
          immutable: true,
        },
      })
      .defineOperations({ create: async () => undefined, delete: deleteSpy });
    const resources: BaseResource[] = [
      new Orphan("orphan", { config: { name: "orphan" } }),
    ];
    const runtime = createRuntime(resources, "validate-orphan", {
      registry: createResourceRegistry([Orphan]),
    });
    await runtime.run("validate-orphan-1");

    strict = true;
    resources.length = 0;
    await runtime.run("validate-orphan-2");

    expect(deleteSpy).toHaveBeenCalledOnce();
    expect(await runtime.state.get("orphan")).toBeUndefined();
    runtime.close();
  });
});

describe("dependency cycles", () => {
  /**
   * Workers that bind each other by name, as Cloudflare Workers do through
   * service bindings. The fake provider refuses an upload that binds a
   * Worker that doesn't exist. It refuses the delete of a Worker that
   * another Worker binds, unless that Worker is one of the dependents that
   * deploy passes to the delete. With `versioned`, each create and update makes a new
   * version, and bindings are not checked. With `blocksDelete`, a Worker
   * blocks the delete of the Workers it depends on, so a replacement deletes
   * them first, and bindings are not checked. With `readable`, a read
   * reports whether the Worker exists.
   */
  function defineWorkers(
    opts: {
      versioned?: boolean;
      blocksDelete?: boolean;
      readable?: boolean;
    } = {},
  ) {
    const remote = new Map<string, string[]>();
    const calls: string[] = [];
    const failCreate = new Set<string>();
    let version = 0;
    const put = (verb: string, params: any) => {
      const bindings: string[] = params.bindings ?? [];
      for (const bound of bindings) {
        if (
          opts.versioned ||
          opts.blocksDelete ||
          bound === params.name ||
          remote.has(bound)
        ) {
          continue;
        }
        throw new Error(`${params.name} binds ${bound}, which does not exist`);
      }
      remote.set(params.name, bindings);
      calls.push(`${verb} ${params.name} [${bindings.join(", ")}]`);
    };
    const type = "test/durable/cycle-worker" as const;
    const Worker = resource({
      type,
      provider: "test",
      deleteTakesDependents: true,
      ...(opts.blocksDelete ? { blocksDeleteOf: [type] } : {}),
    })
      .defineSchema({
        name: {
          propertyType: "param",
          presence: "required",
          primaryKey: true,
          value: v.string(),
        },
        bindings: {
          propertyType: "param",
          presence: "optional",
          value: v.array(v.string()),
          collect: (items: string[][]) => items.flat(),
        },
        version: {
          propertyType: "computed",
          presence: "optional",
          value: v.string(),
        },
      } as any)
      .defineOperations({
        create: async (params: any) => {
          if (failCreate.delete(params.name)) {
            throw new Error(`create ${params.name} failed`);
          }
          put("create", params);
        },
        read: opts.versioned
          ? async () => ({ version: `v${(version += 1)}` }) as any
          : opts.readable
            ? async (key: any) => {
                if (!remote.has(key.name)) {
                  throw new ResourceNotFoundError(`${key.name} not found`);
                }
                return {} as any;
              }
            : undefined,
        update: async (_key: any, _patch: any, params: any) =>
          put("update", params),
        delete: async (
          key: any,
          _state: any,
          _context: any,
          deletion?: ResourceDeletion,
        ) => {
          const dependents = new Set(
            deletion?.dependents.map(({ params }) => params.name),
          );
          for (const [other, bindings] of remote) {
            if (opts.blocksDelete || dependents.has(other)) continue;
            if (other !== key.name && bindings.includes(key.name)) {
              throw new Error(`${other} still binds ${key.name}`);
            }
          }
          remote.delete(key.name);
          calls.push(`delete ${key.name}`);
        },
      });
    const worker = (id: string, name = id): BaseResource =>
      new Worker(id, { config: { name } as any });
    const bind = (from: BaseResource, to: BaseResource, output = "name") =>
      from.contribute({ bindings: [to.outputRef(output)] } as any);
    return { Worker, worker, bind, remote, calls, failCreate };
  }

  it("creates one member as a placeholder, and updates it once the other exists", async () => {
    const { worker, bind, remote, calls } = defineWorkers();
    const a = worker("a");
    const b = worker("b");
    bind(a, b);
    bind(b, a);
    const events: ReconcilerEvent[] = [];
    const runtime = createRuntime([a, b], "cycle-create", {
      emit: (event) => void events.push(event),
    });

    await runtime.run("cycle-create-1");

    expect(calls).toEqual(["create a []", "create b [a]", "update a [b]"]);
    expect(remote).toEqual(
      new Map([
        ["a", ["b"]],
        ["b", ["a"]],
      ]),
    );
    expect(await runtime.state.get("a")).toMatchObject({
      params: { name: "a", bindings: ["b"] },
      dependsOn: ["b"],
    });
    expect(
      events
        .filter((event) => event.event === "reconciler.deploy.decision")
        .map(({ resourceId, decision, placeholder }: any) => ({
          resourceId,
          decision,
          ...(placeholder ? { placeholder } : {}),
        })),
    ).toEqual([
      { resourceId: "a", decision: "create", placeholder: true },
      { resourceId: "b", decision: "create" },
      { resourceId: "a", decision: "update" },
    ]);

    calls.length = 0;
    await runtime.run("cycle-create-2");
    expect(calls).toEqual([]);
    runtime.close();
  });

  it("updates a placeholder that a failed deploy left", async () => {
    const { worker, bind, calls, failCreate } = defineWorkers();
    const a = worker("a");
    const b = worker("b");
    bind(a, b);
    bind(b, a);
    const runtime = createRuntime([a, b], "cycle-resume");
    failCreate.add("b");

    await expect(runtime.run("cycle-resume-1")).rejects.toThrow(
      "create b failed",
    );
    expect(calls).toEqual(["create a []"]);
    expect(await runtime.state.get("a")).toMatchObject({
      params: { name: "a" },
    });

    calls.length = 0;
    await runtime.run("cycle-resume-2");
    expect(calls).toEqual(["create b [a]", "update a [b]"]);
    runtime.close();
  });

  it("creates a dependent outside the cycle after the cycle settles", async () => {
    const { worker, bind, calls } = defineWorkers();
    const a = worker("a");
    const b = worker("b");
    const c = worker("c");
    bind(a, b);
    bind(b, a);
    bind(c, a);
    const runtime = createRuntime([c, a, b], "cycle-dependent");

    await runtime.run("cycle-dependent-1");

    expect(calls).toEqual([
      "create a []",
      "create b [a]",
      "update a [b]",
      "create c [a]",
    ]);
    runtime.close();
  });

  it("does not create a dependent outside the cycle when the cycle fails after its placeholder exists", async () => {
    const { worker, bind, calls, failCreate } = defineWorkers();
    const a = worker("a");
    const b = worker("b");
    const c = worker("c");
    bind(a, b);
    bind(b, a);
    bind(c, a);
    const runtime = createRuntime([c, a, b], "cycle-dependent-fail");
    failCreate.add("b");

    await expect(runtime.run("cycle-dependent-fail-1")).rejects.toThrow(
      "create b failed",
    );
    expect(calls).toEqual(["create a []"]);

    calls.length = 0;
    await runtime.run("cycle-dependent-fail-2");
    expect(calls).toEqual(["create b [a]", "update a [b]", "create c [a]"]);
    runtime.close();
  });

  it("fails when an output that a member takes changes on every update", async () => {
    const { worker, bind } = defineWorkers({ versioned: true });
    const a = worker("a");
    const b = worker("b");
    bind(a, b, "version");
    bind(b, a, "version");
    const runtime = createRuntime([a, b], "cycle-unsettled");

    const run = runtime.run("cycle-unsettled-1");
    await expect(run).rejects.toThrow(
      "The cycle of a and b did not settle after 3 passes.",
    );
    await expect(run).rejects.toThrow("a.version");
    runtime.close();
  });

  it("deletes the members of a cycle in destroy while a member in state still refers to them", async () => {
    const { worker, bind, remote, calls } = defineWorkers();
    const a = worker("a");
    const b = worker("b");
    bind(a, b);
    bind(b, a);
    const runtime = createRuntime([a, b], "cycle-destroy");
    await runtime.run("cycle-destroy-1");
    calls.length = 0;

    await runtime.destroy("cycle-destroy-2");

    expect(calls).toEqual(["delete b", "delete a"]);
    expect(remote.size).toBe(0);
    expect(await runtime.state.values()).toHaveLength(0);
    runtime.close();
  });

  it("replaces two members that refer to each other in one deploy", async () => {
    const { worker, bind, calls, remote } = defineWorkers();
    const a = worker("a");
    const b = worker("b");
    bind(a, b);
    bind(b, a);
    const resources = [a, b];
    const runtime = createRuntime(resources, "cycle-rename-both");
    await runtime.run("cycle-rename-both-1");
    calls.length = 0;

    const nextA = worker("a", "a2");
    const nextB = worker("b", "b2");
    bind(nextA, nextB);
    bind(nextB, nextA);
    resources.splice(0, 2, nextA, nextB);
    await runtime.run("cycle-rename-both-2");

    expect(calls).toEqual([
      "delete b",
      "create b2 [a]",
      "delete a",
      "create a2 [b2]",
      "update b2 [a2]",
    ]);
    expect(remote).toEqual(
      new Map([
        ["a2", ["b2"]],
        ["b2", ["a2"]],
      ]),
    );
    runtime.close();
  });

  it("keeps the contributions that don't refer to other members in the placeholder", async () => {
    const { worker, bind, calls } = defineWorkers();
    const shared = worker("shared");
    const a = worker("a");
    const b = worker("b");
    bind(a, shared);
    bind(a, b);
    bind(b, a);
    const runtime = createRuntime([a, b, shared], "cycle-kept");

    await runtime.run("cycle-kept-1");
    expect(calls).toEqual([
      "create shared []",
      "create a [shared]",
      "create b [a]",
      "update a [b, shared]",
    ]);

    calls.length = 0;
    await runtime.destroy("cycle-kept-2");
    expect(calls).toEqual(["delete b", "delete a", "delete shared"]);
    runtime.close();
  });

  it("does not read a placeholder that it created for drift in the next pass", async () => {
    const { worker, bind } = defineWorkers({ versioned: true });
    const a = worker("a");
    const b = worker("b");
    // A contribution that sets nothing, so that the placeholder's full params
    // are its placeholder params, and the next pass decides noop for it.
    a.contribute(() => ({}), { deps: { b } });
    bind(b, a);
    const events: ReconcilerEvent[] = [];
    const runtime = createRuntime([a, b], "cycle-drift", {
      driftDetection: true,
      emit: (event) => void events.push(event),
    });

    await runtime.run("cycle-drift-1");
    // Only the read that follows each create.
    expect(
      events
        .filter(
          (event: any) =>
            event.event === "reconciler.operation.lifecycle" &&
            event.operation === "read" &&
            event.status === "start",
        )
        .map((event: any) => event.resourceId),
    ).toEqual(["a", "b"]);
    runtime.close();
  });

  it("reads a placeholder that has a record once for drift", async () => {
    const { worker, bind, calls } = defineWorkers({ readable: true });
    const a = worker("a");
    const b = worker("b");
    bind(a, b);
    bind(b, a);
    const events: ReconcilerEvent[] = [];
    const runtime = createRuntime([a, b], "cycle-drift-kept", {
      driftDetection: true,
      emit: (event) => void events.push(event),
    });
    await runtime.run("cycle-drift-kept-1");
    events.length = 0;
    calls.length = 0;

    await runtime.run("cycle-drift-kept-2");

    expect(calls).toEqual([]);
    expect(
      events
        .filter(
          (event: any) =>
            event.event === "reconciler.operation.lifecycle" &&
            event.operation === "read" &&
            event.status === "start",
        )
        .map((event: any) => event.resourceId),
    ).toEqual(["a", "b"]);
    expect(
      events
        .filter((event) => event.event === "reconciler.deploy.decision")
        .map(({ resourceId, decision }: any) => ({ resourceId, decision })),
    ).toEqual([
      { resourceId: "b", decision: "noop" },
      { resourceId: "a", decision: "noop" },
    ]);
    runtime.close();
  });

  it("does not trip the create guard in a dry run of a new cycle", async () => {
    const { worker, bind, calls } = defineWorkers();
    const a = worker("a");
    const b = worker("b");
    bind(a, b);
    bind(b, a);
    const runtime = createRuntime([a, b], "cycle-dry-run", { dryRun: true });

    // A dry run creates nothing, so b can't read the name of a, as in any
    // new chain of resources.
    const run = runtime.run("cycle-dry-run-1");
    await expect(run).rejects.toThrow(
      "Output a.name was read before a was deployed",
    );
    await expect(run).rejects.not.toThrow(ResourceCycleError);
    expect(calls).toEqual([]);
    runtime.close();
  });

  it("runs only the first pass in a dry run, so a replacement is not decided twice", async () => {
    const { worker, bind, calls } = defineWorkers();
    const a = worker("a");
    const b = worker("b");
    bind(a, b);
    bind(b, a);
    const resources = [a, b];
    const options = { dryRun: false };
    const events: ReconcilerEvent[] = [];
    const runtime = createRuntime(resources, "cycle-dry-run-replace", {
      get dryRun() {
        return options.dryRun;
      },
      emit: (event) => void events.push(event),
    });
    await runtime.run("cycle-dry-run-replace-1");
    calls.length = 0;
    events.length = 0;

    const nextA = worker("a");
    const nextB = worker("b", "b2");
    bind(nextA, nextB);
    bind(nextB, nextA);
    resources.splice(0, 2, nextA, nextB);
    options.dryRun = true;
    await runtime.run("cycle-dry-run-replace-2");

    expect(calls).toEqual([]);
    expect(
      events
        .filter((event) => event.event === "reconciler.deploy.decision")
        .map((event: any) => [event.resourceId, event.decision]),
    ).toEqual([
      ["b", "replace"],
      ["a", "noop"],
    ]);
    runtime.close();
  });

  it("names the replacement when a member that it deleted would be created again", async () => {
    const { worker, bind } = defineWorkers({ blocksDelete: true });
    const resources = [worker("a")];
    const runtime = createRuntime(resources, "cycle-cascade");
    await runtime.run("cycle-cascade-1");

    const a = worker("a", "a2");
    const b = worker("b");
    bind(a, b);
    b.dependOn(a);
    resources.splice(0, 1, a, b);
    const run = runtime.run("cycle-cascade-2");
    await expect(run).rejects.toThrow(ResourceCycleError);
    await expect(run).rejects.toThrow(
      "b would be created again while its cycle with a settles. This deploy created it, and its record was deleted again, when deploy replaced a and deleted the resources that block that delete.",
    );
    runtime.close();
  });

  it("creates a replaced member without its contributions that refer to a member that the replacement deleted", async () => {
    const { worker, bind, calls, remote } = defineWorkers({
      blocksDelete: true,
    });
    const declare = (name: string) => {
      const p = worker("p");
      const d = worker("d");
      const r = worker("r", name);
      bind(p, d);
      d.dependOn(r);
      bind(r, p);
      return [p, d, r];
    };
    const resources = declare("r");
    const runtime = createRuntime(resources, "cycle-cascade-binding");
    await runtime.run("cycle-cascade-binding-1");
    calls.length = 0;

    resources.splice(0, 3, ...declare("r2"));
    await runtime.run("cycle-cascade-binding-2");

    expect(calls).toEqual([
      "delete p",
      "delete d",
      "delete r",
      "create r2 []",
      "create d []",
      "create p [d]",
      "update r2 [p]",
    ]);
    expect(remote).toEqual(
      new Map([
        ["r2", ["p"]],
        ["d", []],
        ["p", ["d"]],
      ]),
    );
    runtime.close();
  });

  it("destroys a cycle when a member has a new dependency with no record", async () => {
    const { worker, bind, calls } = defineWorkers();
    const a = worker("a");
    const b = worker("b");
    bind(a, b);
    bind(b, a);
    const resources = [a, b];
    const runtime = createRuntime(resources, "cycle-missing-dependency");
    await runtime.run("cycle-missing-dependency-1");
    calls.length = 0;

    const role = worker("role");
    const nextA = worker("a");
    const nextB = worker("b");
    nextA.dependOn(role);
    bind(nextA, nextB);
    bind(nextB, nextA);
    resources.splice(0, 2, role, nextA, nextB);

    await runtime.destroy("cycle-missing-dependency-2");

    expect(calls).toEqual(["delete b", "delete a"]);
    runtime.close();
  });

  it("replaces a member that another member refers to, and updates that member with the new output", async () => {
    const { worker, bind, calls } = defineWorkers();
    const a = worker("a");
    const b = worker("b");
    bind(a, b);
    bind(b, a);
    const resources = [a, b];
    const events: ReconcilerEvent[] = [];
    const runtime = createRuntime(resources, "cycle-replace", {
      emit: (event) => void events.push(event),
    });
    await runtime.run("cycle-replace-1");
    calls.length = 0;
    events.length = 0;

    const nextA = worker("a");
    const nextB = worker("b", "b2");
    bind(nextA, nextB);
    bind(nextB, nextA);
    resources.splice(0, 2, nextA, nextB);
    await runtime.run("cycle-replace-2");

    expect(calls).toEqual(["delete b", "create b2 [a]", "update a [b2]"]);
    runtime.close();
  });
  it("creates a placeholder again in the first pass when it was deleted outside Notation", async () => {
    const { worker, bind, remote, calls } = defineWorkers({ readable: true });
    const shared = worker("shared");
    const a = worker("a");
    const b = worker("b");
    bind(a, b);
    bind(b, a);
    const resources = [shared, a, b];
    const runtime = createRuntime(resources, "cycle-placeholder-gone", {
      driftDetection: true,
    });
    await runtime.run("cycle-placeholder-gone-1");
    remote.delete("a");
    calls.length = 0;

    const nextA = worker("a");
    const nextB = worker("b");
    bind(nextA, nextB);
    bind(nextB, nextA);
    bind(nextB, shared);
    resources.splice(1, 2, nextA, nextB);
    await runtime.run("cycle-placeholder-gone-2");

    expect(calls).toEqual([
      "create a []",
      "update b [a, shared]",
      "update a [b]",
    ]);
    runtime.close();
  });

  // c is outside the cycle, but its record depends on b, so deploy passes
  // it to the delete of b as a dependent, and the provider allows the delete.
  it("replaces a member that a resource outside the cycle refers to", async () => {
    const { worker, bind, calls } = defineWorkers();
    const a = worker("a");
    const b = worker("b");
    const c = worker("c");
    bind(a, b);
    bind(b, a);
    bind(c, b);
    const resources = [a, b, c];
    const runtime = createRuntime(resources, "cycle-replace-outside");
    await runtime.run("cycle-replace-outside-1");
    calls.length = 0;

    const nextA = worker("a");
    const nextB = worker("b", "b2");
    const nextC = worker("c");
    bind(nextA, nextB);
    bind(nextB, nextA);
    bind(nextC, nextB);
    resources.splice(0, 3, nextA, nextB, nextC);

    await runtime.run("cycle-replace-outside-2");

    expect(calls).toEqual([
      "delete b",
      "create b2 [a]",
      "update a [b2]",
      "update c [b2]",
    ]);
    runtime.close();
  });

  it("leaves the delete of a replaced member to the provider when a resource that is not in state refers to it", async () => {
    const { worker, bind, calls, remote } = defineWorkers();
    const a = worker("a");
    const b = worker("b");
    bind(a, b);
    bind(b, a);
    const resources = [a, b];
    const runtime = createRuntime(resources, "cycle-replace-foreign");
    await runtime.run("cycle-replace-foreign-1");
    calls.length = 0;
    remote.set("other-app", ["b"]);

    const nextA = worker("a");
    const nextB = worker("b", "b2");
    bind(nextA, nextB);
    bind(nextB, nextA);
    resources.splice(0, 2, nextA, nextB);

    await expect(runtime.run("cycle-replace-foreign-2")).rejects.toThrow(
      "other-app still binds b",
    );
    expect(calls).toEqual([]);
    expect(remote.get("a")).toEqual(["b"]);
    runtime.close();
  });

  it("deletes two orphans that refer to each other in the sweep", async () => {
    const { Worker, worker, bind, calls, remote } = defineWorkers();
    const a = worker("a");
    const b = worker("b");
    bind(a, b);
    bind(b, a);
    const resources = [a, b];
    const runtime = createRuntime(resources, "cycle-orphans", {
      registry: createResourceRegistry([Worker as any]),
    });
    await runtime.run("cycle-orphans-1");
    calls.length = 0;

    resources.splice(0, 2);
    await runtime.run("cycle-orphans-2");

    expect([...calls].sort()).toEqual(["delete a", "delete b"]);
    expect(remote.size).toBe(0);
    expect(await runtime.state.values()).toHaveLength(0);
    runtime.close();
  });

  it("deletes the resources that block the delete of a replaced member, in and outside the cycle", async () => {
    const { worker, bind, calls, remote } = defineWorkers({
      blocksDelete: true,
    });
    const a = worker("a");
    const b = worker("b");
    const c = worker("c");
    bind(a, b);
    bind(b, a);
    bind(c, b);
    const resources = [a, b, c];
    const runtime = createRuntime(resources, "cycle-replace-outside-blocks");
    await runtime.run("cycle-replace-outside-blocks-1");
    calls.length = 0;

    const nextA = worker("a");
    const nextB = worker("b", "b2");
    const nextC = worker("c");
    bind(nextA, nextB);
    bind(nextB, nextA);
    bind(nextC, nextB);
    resources.splice(0, 3, nextA, nextB, nextC);
    await runtime.run("cycle-replace-outside-blocks-2");

    // a and c block the delete of b, so the replacement deletes them, and
    // deploy creates them again when it reaches them. b2 is created without
    // its contribution that refers to a, as a does not exist then.
    expect(calls).toEqual([
      "delete a",
      "delete c",
      "delete b",
      "create b2 []",
      "create a [b2]",
      "update b2 [a]",
      "create c [b2]",
    ]);
    expect(remote.get("c")).toEqual(["b2"]);
    runtime.close();
  });

  it("replaces the placeholder of a cycle", async () => {
    const { worker, bind, calls, remote } = defineWorkers();
    const a = worker("a");
    const b = worker("b");
    bind(a, b);
    bind(b, a);
    const resources = [a, b];
    const runtime = createRuntime(resources, "cycle-replace-placeholder");
    await runtime.run("cycle-replace-placeholder-1");
    calls.length = 0;

    const nextA = worker("a", "a2");
    const nextB = worker("b");
    bind(nextA, nextB);
    bind(nextB, nextA);
    resources.splice(0, 2, nextA, nextB);
    await runtime.run("cycle-replace-placeholder-2");

    expect(calls).toEqual(["delete a", "create a2 [b]", "update b [a2]"]);
    expect(remote).toEqual(
      new Map([
        ["a2", ["b"]],
        ["b", ["a2"]],
      ]),
    );
    runtime.close();
  });

  it("replaces a resource that contributes its own output to itself", async () => {
    const { worker, bind, calls, remote } = defineWorkers();
    const a = worker("a");
    bind(a, a);
    const resources = [a];
    const runtime = createRuntime(resources, "cycle-replace-self");
    await runtime.run("cycle-replace-self-1");
    calls.length = 0;

    const nextA = worker("a", "a2");
    bind(nextA, nextA);
    resources.splice(0, 1, nextA);
    await runtime.run("cycle-replace-self-2");

    expect(calls).toEqual(["delete a", "create a2 []", "update a2 [a2]"]);
    expect(remote).toEqual(new Map([["a2", ["a2"]]]));
    runtime.close();
  });

  it("deploys a resource that contributes its own output to itself", async () => {
    const { worker, bind, calls } = defineWorkers();
    const a = worker("a");
    bind(a, a);
    const runtime = createRuntime([a], "cycle-self");

    await runtime.run("cycle-self-1");
    expect(calls).toEqual(["create a []", "update a [a]"]);

    calls.length = 0;
    await runtime.run("cycle-self-2");
    expect(calls).toEqual([]);
    runtime.close();
  });

  it("reports the update of a placeholder that has a record in a dry run", async () => {
    const { worker, bind, calls } = defineWorkers();
    const shared = worker("shared");
    const a = worker("a");
    const b = worker("b");
    bind(a, b);
    bind(b, a);
    const resources = [shared, a, b];
    const options = { dryRun: false };
    const events: ReconcilerEvent[] = [];
    const runtime = createRuntime(resources, "cycle-dry-run-placeholder", {
      get dryRun() {
        return options.dryRun;
      },
      emit: (event) => void events.push(event),
    });
    await runtime.run("cycle-dry-run-placeholder-1");
    calls.length = 0;
    events.length = 0;

    const nextA = worker("a");
    const nextB = worker("b");
    bind(nextA, nextB);
    bind(nextA, shared);
    bind(nextB, nextA);
    resources.splice(1, 2, nextA, nextB);
    options.dryRun = true;
    await runtime.run("cycle-dry-run-placeholder-2");

    expect(calls).toEqual([]);
    expect(
      events
        .filter((event) => event.event === "reconciler.deploy.decision")
        .map((event: any) => [event.resourceId, event.decision]),
    ).toEqual([
      ["shared", "noop"],
      ["b", "noop"],
      ["a", "update"],
    ]);
    runtime.close();
  });

  it("keeps the other contributions of a member that refers to a replaced member", async () => {
    const { worker, bind, calls } = defineWorkers();
    const a = worker("a");
    const b = worker("b");
    const c = worker("c");
    bind(a, b);
    bind(a, c);
    bind(b, a);
    bind(c, a);
    const resources = [a, b, c];
    const runtime = createRuntime(resources, "cycle-replace-narrow");
    await runtime.run("cycle-replace-narrow-1");
    calls.length = 0;

    const nextA = worker("a");
    const nextB = worker("b");
    const nextC = worker("c", "c2");
    bind(nextA, nextB);
    bind(nextA, nextC);
    bind(nextB, nextA);
    bind(nextC, nextA);
    resources.splice(0, 3, nextA, nextB, nextC);
    await runtime.run("cycle-replace-narrow-2");

    expect(calls).toEqual(["delete c", "create c2 [a]", "update a [b, c2]"]);
    runtime.close();
  });

  it("records only the fixed edges of a placeholder that it created without its contributions", async () => {
    const { worker, bind, failCreate } = defineWorkers();
    const a = worker("a");
    const b = worker("b");
    bind(a, b);
    bind(b, a);
    const runtime = createRuntime([a, b], "cycle-placeholder-edges");
    failCreate.add("b");

    await expect(runtime.run("cycle-placeholder-edges-1")).rejects.toThrow(
      "create b failed",
    );
    expect(await runtime.state.get("a")).toMatchObject({ dependsOn: [] });

    await runtime.run("cycle-placeholder-edges-2");
    expect(await runtime.state.get("a")).toMatchObject({ dependsOn: ["b"] });
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
    joins: sqliteRuntime.joins,
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

  recordCancellation(params: Parameters<HeapClient["recordCancellation"]>[0]) {
    return this.inner.recordCancellation(params);
  }

  async writeStep(params: Parameters<HeapClient["writeStep"]>[0]) {
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
    provider: "test",
    group: null,
    config: {},
    params: {},
    output: {},
    lastOperation: "create" as const,
    lastOperationAt: new Date().toISOString(),
  };
}
