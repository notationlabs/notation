import { describe, expect, it, vi } from "vitest";
import {
  resource,
  ResourceNotFoundError,
  ResourceOperationPendingError,
} from "@notation/resource";
import {
  createResourceOperation,
  deleteResourceOperation,
  readResourceOperation,
  type OperationLifecycleEvent,
  type StepRunner,
} from "../src/operations";
import { toEmitStep } from "../src/events";

function createStepRunnerDouble(): StepRunner {
  const run = vi.fn(async function* <T>(
    arg1: string | (() => T | Promise<T>),
    arg2?: () => T | Promise<T>,
  ): AsyncGenerator<unknown, T, unknown> {
    const fn = (typeof arg1 === "string" ? arg2 : arg1) as () => T | Promise<T>;
    if (!fn) {
      throw new Error("Missing run function");
    }

    return await fn();
  });

  const delay = vi.fn(async function* (): AsyncGenerator<
    unknown,
    void,
    unknown
  > {
    return;
  });

  return {
    run,
    delay,
  };
}

async function runOperation<T>(operation: AsyncGenerator<unknown, T, unknown>) {
  let next = await operation.next();
  while (!next.done) {
    next = await operation.next();
  }
  return next.value;
}

describe("operation workflows", () => {
  it("create performs create + read-after-create + state persistence", async () => {
    const step = createStepRunnerDouble();
    const events: OperationLifecycleEvent[] = [];
    const state = { get: vi.fn(async () => undefined) };
    const persist = vi.fn(async function* () {});

    let createAttempts = 0;
    const createMock = vi.fn(async (_params, context) => {
      createAttempts += 1;
      if (createAttempts === 1) {
        expect(context).toBeUndefined();
        throw Object.assign(new Error("retry create"), {
          _tag: "ResourceOperationPendingError",
          retryAfterMs: 25,
          callbackContext: { operationId: "create-123" },
        });
      }
      expect(context).toEqual({ operationId: "create-123" });
      return { remoteId: "abc" };
    });

    const TestResource = resource({ type: "test/service/create" })
      .defineSchema({})
      .defineOperations({
        create: createMock,
        read: async () => ({ remoteId: "abc", status: "ready" }),
        delete: async () => undefined,
      });

    const testResource = new TestResource({ id: "test-create" });

    await runOperation(
      createResourceOperation(step, {
        resource: testResource,
        state,
        persist,
        emit: toEmitStep((event) => void events.push(event)),
      }),
    );

    expect(createAttempts).toBe(2);
    expect(persist).toHaveBeenCalledOnce();
    expect(persist).toHaveBeenCalledWith({
      id: "test-create",
      groupId: testResource.groupId,
      groupType: testResource.groupType,
      type: TestResource.type,
      lastOperation: "create",
      lastOperationAt: expect.any(String),
      config: testResource.config,
      params: {},
      // The resource declares no schema, so nothing survives toState.
      output: {},
    });
    expect(createMock).toHaveBeenNthCalledWith(
      1,
      await testResource.getParams(),
      undefined,
    );
    expect(createMock).toHaveBeenNthCalledWith(
      2,
      await testResource.getParams(),
      { operationId: "create-123" },
    );
    expect(testResource.output).toEqual({ remoteId: "abc", status: "ready" });
    expect(events.map((event) => `${event.operation}:${event.status}`)).toEqual(
      ["create:start", "read:start", "read:success", "create:success"],
    );
    expect(events[0]).toMatchObject({
      resourceId: "test-create",
      resourceType: TestResource.type,
      event: "reconciler.operation.lifecycle",
    });
  });

  it("read follows pending retry instructions", async () => {
    const step = createStepRunnerDouble();
    const state = {
      get: vi.fn(async () => undefined),
      update: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    };

    let readAttempts = 0;
    const TestResource = resource({ type: "test/service/read" })
      .defineSchema({})
      .defineOperations({
        create: async () => ({}),
        read: async (_key, context) => {
          readAttempts += 1;
          if (readAttempts < 3) {
            throw new ResourceOperationPendingError("resource is not ready", {
              retryAfterMs: readAttempts * 10,
              callbackContext: { readAttempts },
            });
          }
          expect(context).toEqual({ readAttempts: 2 });
          return { status: "ready" } as const;
        },
        delete: async () => undefined,
      });

    const testResource = new TestResource({ id: "test-read" });

    const result = await runOperation(
      readResourceOperation(step, {
        resource: testResource,
        state,
      }),
    );

    expect(readAttempts).toBe(3);
    expect(result).toEqual({ status: "ready" });
    expect(step.delay).toHaveBeenNthCalledWith(
      1,
      "read:remote:retry-delay:0",
      10,
    );
    expect(step.delay).toHaveBeenNthCalledWith(
      2,
      "read:remote:retry-delay:1",
      20,
    );
  });

  it("fails when an operation remains pending past the safety limit", async () => {
    const step = createStepRunnerDouble();
    const state = {
      get: vi.fn(async () => undefined),
      update: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    };
    const read = vi.fn(async () => {
      throw new ResourceOperationPendingError("still pending", {
        retryAfterMs: 10,
      });
    });
    const TestResource = resource({ type: "test/service/pending-limit" })
      .defineSchema({})
      .defineOperations({
        create: async () => ({}),
        read,
        delete: async () => undefined,
      });

    await expect(
      runOperation(
        readResourceOperation(step, {
          resource: new TestResource({ id: "pending-limit" }),
          state,
          maxOperationAttempts: 2,
        }),
      ),
    ).rejects.toThrowError("still pending after 2 attempts");
    expect(read).toHaveBeenCalledTimes(2);
    expect(step.delay).toHaveBeenCalledOnce();
  });

  it("does not infer that not-found after creation is retryable", async () => {
    const step = createStepRunnerDouble();
    const state = {
      get: vi.fn(async () => undefined),
      update: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    };
    const TestResource = resource({ type: "test/service/eventually-visible" })
      .defineSchema({})
      .defineOperations({
        create: async () => ({}),
        read: async () => {
          throw new ResourceNotFoundError("resource is absent");
        },
        delete: async () => undefined,
      });

    await expect(
      runOperation(
        createResourceOperation(step, {
          resource: new TestResource({ id: "eventually-visible" }),
          state,
          expectedRev: 0,
        }),
      ),
    ).rejects.toThrowError("resource is absent");
    expect(state.update).not.toHaveBeenCalled();
  });

  it("delete treats an already-absent remote as success through its idempotent resource contract", async () => {
    const step = createStepRunnerDouble();
    const events: OperationLifecycleEvent[] = [];
    const state = { get: vi.fn(async () => undefined) };
    const remove = vi.fn(async function* () {});

    const TestResource = resource({ type: "test/service/delete" })
      .defineSchema({})
      .defineOperations({
        create: async () => ({}),
        delete: async () => undefined,
      });

    const testResource = new TestResource({ id: "test-delete" });

    await runOperation(
      deleteResourceOperation(step, {
        resource: testResource,
        state,
        remove,
        emit: toEmitStep((event) => void events.push(event)),
      }),
    );

    // State is removed only after the provider delete resolves; which record
    // and revision that targets is the driver's concern, not the operation's.
    expect(remove).toHaveBeenCalledOnce();
    expect(events.map((event) => event.status)).toEqual(["start", "success"]);
  });

  it("delete rethrows an unclassified resource error", async () => {
    const step = createStepRunnerDouble();
    const state = {
      get: vi.fn(async () => undefined),
      update: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    };

    const TestResource = resource({ type: "test/service/delete-miss" })
      .defineSchema({})
      .defineOperations({
        create: async () => ({}),
        delete: async () => {
          const err = new Error("still exists");
          err.name = "DifferentError";
          throw err;
        },
      });

    const testResource = new TestResource({ id: "test-delete-miss" });

    await expect(
      runOperation(
        deleteResourceOperation(step, {
          resource: testResource,
          state,
          expectedRev: 1,
        }),
      ),
    ).rejects.toMatchObject({
      name: "DifferentError",
      message: "still exists",
    });

    expect(state.delete).not.toHaveBeenCalled();
  });

  it("emits structured error details on operation failure", async () => {
    const step = createStepRunnerDouble();
    const events: OperationLifecycleEvent[] = [];
    const state = {
      get: vi.fn(async () => undefined),
      update: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    };

    const TestResource = resource({ type: "test/service/create-error" })
      .defineSchema({})
      .defineOperations({
        create: async () => {
          const err = new Error("boom");
          err.name = "CreateFailed";
          throw err;
        },
        delete: async () => undefined,
      });

    const testResource = new TestResource({ id: "test-create-error" });

    await expect(
      runOperation(
        createResourceOperation(step, {
          resource: testResource,
          state,
          expectedRev: 0,
          emit: toEmitStep((event) => void events.push(event)),
        }),
      ),
    ).rejects.toMatchObject({ name: "CreateFailed", message: "boom" });

    expect(events.map((event) => event.status)).toEqual(["start", "error"]);
    expect(events[1]).toMatchObject({
      operation: "create",
      status: "error",
      resourceId: "test-create-error",
      resourceType: TestResource.type,
      errorName: "CreateFailed",
      errorMessage: "boom",
    });
  });
});
