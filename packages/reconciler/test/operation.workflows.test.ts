import { describe, expect, it, vi } from "vitest";
import { RetryableError } from "yieldstar";
import { resource } from "@notation/resource";
import {
  createResourceOperation,
  deleteResourceOperation,
  readResourceOperation,
  type OperationLifecycleEvent,
  type PollOptions,
  type StepRunner,
} from "../src/operations";

function createStepRunnerDouble(): StepRunner {
  const run = vi.fn(async function* <T>(
    arg1: string | (() => T | Promise<T>),
    arg2?: () => T | Promise<T>,
  ): AsyncGenerator<unknown, T, unknown> {
    const fn = (typeof arg1 === "string" ? arg2 : arg1) as () => T | Promise<T>;
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
  });

  const poll = vi.fn(async function* (
    arg1: string | PollOptions,
    arg2: PollOptions | (() => boolean | Promise<boolean>),
    arg3?: () => boolean | Promise<boolean>,
  ): AsyncGenerator<unknown, void, unknown> {
    const opts = (typeof arg1 === "string" ? arg2 : arg1) as PollOptions;
    const predicate = (typeof arg1 === "string" ? arg3 : arg2) as
      | (() => boolean | Promise<boolean>)
      | undefined;

    if (!predicate) {
      throw new Error("Missing poll predicate");
    }

    for (let attempt = 0; attempt < opts.maxAttempts; attempt++) {
      if (await predicate()) {
        return;
      }
    }

    throw new RetryableError("Polling reached max retries", {
      maxAttempts: opts.maxAttempts,
      retryInterval: opts.retryInterval,
    });
  });

  const delay = vi.fn(async function* (): AsyncGenerator<unknown, void, unknown> {
    return;
  });

  return {
    run,
    poll,
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
    const state = {
      get: vi.fn(async () => undefined),
      update: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    };

    let createAttempts = 0;
    const TestResource = resource({ type: "test/service/create" })
      .defineSchema({})
      .defineOperations({
        create: async () => {
          createAttempts += 1;
          if (createAttempts === 1) {
            const err = new Error("eventual consistency");
            err.name = "RetryCreate";
            throw err;
          }
          return { remoteId: "abc" };
        },
        read: async () => ({ remoteId: "abc", status: "ready" }),
        delete: async () => undefined,
        retryLaterOnError: [{ name: "RetryCreate", reason: "retry create" }],
      });

    const testResource = new TestResource({ id: "test-create" });

    await runOperation(
      createResourceOperation(step, {
        resource: testResource,
        state,
        emit: async (event) => {
          events.push(event);
        },
      }),
    );

    expect(createAttempts).toBe(2);
    expect(state.update).toHaveBeenCalledOnce();
    expect(testResource.output).toEqual({ remoteId: "abc", status: "ready" });
    expect(events.map((event) => `${event.operation}:${event.status}`)).toEqual([
      "create:start",
      "read:start",
      "read:success",
      "create:success",
    ]);
    expect(events[0]).toMatchObject({
      resourceId: "test-create",
      resourceType: TestResource.type,
      event: "reconciler.operation.lifecycle",
    });
  });

  it("read uses durable polling semantics for retryReadOnCondition", async () => {
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
        read: async () => {
          readAttempts += 1;
          if (readAttempts < 3) {
            return { status: "pending" };
          }
          return { status: "ready" };
        },
        delete: async () => undefined,
        retryReadOnCondition: [
          {
            key: "status",
            value: "ready",
            reason: "resource is not ready",
          },
        ],
      });

    const testResource = new TestResource({ id: "test-read" });

    const result = await runOperation(
      readResourceOperation(step, {
        resource: testResource,
        state,
      }),
    );

    expect(readAttempts).toBe(3);
    expect((step.poll as any).mock.calls.length).toBe(1);
    expect(result).toEqual({ status: "ready" });
  });

  it("delete treats only resource.notFoundOnError matchers as skip", async () => {
    const step = createStepRunnerDouble();
    const events: OperationLifecycleEvent[] = [];
    const state = {
      get: vi.fn(async () => undefined),
      update: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    };

    const TestResource = resource({ type: "test/service/delete" })
      .defineSchema({})
      .defineOperations({
        create: async () => ({}),
        delete: async () => {
          const err = new Error("gone");
          err.name = "RemoteMissing";
          throw err;
        },
        notFoundOnError: [
          {
            name: "RemoteMissing",
            reason: "already deleted remotely",
          },
        ],
      });

    const testResource = new TestResource({ id: "test-delete" });

    await runOperation(
      deleteResourceOperation(step, {
        resource: testResource,
        state,
        emit: async (event) => {
          events.push(event);
        },
      }),
    );

    expect(state.delete).toHaveBeenCalledWith("test-delete");
    expect(events.map((event) => event.status)).toEqual([
      "start",
      "skip",
      "success",
    ]);
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
          emit: async (event) => {
            events.push(event);
          },
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
