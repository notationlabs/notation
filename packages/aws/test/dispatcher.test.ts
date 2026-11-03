import { afterEach, describe, expect, test, vi } from "vitest";
import { encodeRuntime, runtimeVariable } from "@notation/aws.iac/shared";
import type { LambdaRuntime } from "@notation/aws.iac/shared";
import type { Context } from "aws-lambda";
import { createDispatcher, handle, json } from "src/lambda.fn";
import { api, router } from "src/api-gateway";
import { lambda } from "src/lambda";

const context = {} as Context;

const runtime: LambdaRuntime = {
  dispatch: {
    "todo-api-GET-/todos": {
      export: "getTodos",
      match: { apiId: "api-1", routeKey: "GET /todos" },
    },
    "todo-api-POST-/todos": {
      export: "createTodo",
      match: { apiId: "api-1", routeKey: "POST /todos" },
    },
    "orders-todos-mapping": {
      export: "processOrders",
      match: { queueArn: "arn:aws:sqs:eu-west-2:123456789012:orders" },
    },
  },
};

const sendDigest = vi.fn(async () => {});

const todos = {
  getTodos: handle.apiRequest(() => json(["a"])),
  createTodo: handle.apiRequest(() => json("created")),
  processOrders: vi.fn(async () => {}),
  sendDigest: handle.eventBridgeScheduledEvent(sendDigest),
  resource: { service: "aws/lambda", id: "todos" },
};

function dispatcherWith(mod: Record<string, unknown>, value?: LambdaRuntime) {
  vi.stubEnv(runtimeVariable, value ? encodeRuntime(value) : undefined);
  return createDispatcher(mod);
}

const apiRequest = (apiId: string, routeKey: string) => ({
  routeKey,
  requestContext: { apiId },
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("createDispatcher", () => {
  test("sends an API request to the export the dispatch map gives for its route", async () => {
    const handler = dispatcherWith(todos, runtime);

    expect(await handler(apiRequest("api-1", "GET /todos"), context)).toEqual(
      json(["a"]),
    );
    expect(await handler(apiRequest("api-1", "POST /todos"), context)).toEqual(
      json("created"),
    );
  });

  test("matches the API's ID as well as the route key", async () => {
    const handler = dispatcherWith(todos, runtime);

    await expect(
      handler(apiRequest("api-2", "GET /todos"), context),
    ).rejects.toThrow(
      "No export of this module handles the event (HTTP API route GET /todos on API api-2)",
    );
  });

  test("sends SQS messages to the export the dispatch map gives for their queue", async () => {
    const handler = dispatcherWith(todos, runtime);
    const event = {
      Records: [
        {
          eventSource: "aws:sqs",
          eventSourceARN: "arn:aws:sqs:eu-west-2:123456789012:orders",
          body: "{}",
        },
      ],
    };

    await handler(event, context);

    expect(todos.processOrders).toHaveBeenCalledWith(event, context);
  });

  test("sends a scheduled invocation to the export it names, with the original event", async () => {
    const handler = dispatcherWith(todos, runtime);
    const event = { "detail-type": "Scheduled Event", time: "2026-11-02" };

    await handler({ export: "sendDigest", event }, context);

    expect(sendDigest).toHaveBeenCalledWith(event, context);
  });

  test("refuses a scheduled invocation of an export that is not a schedule handler", async () => {
    const handler = dispatcherWith(todos, runtime);

    await expect(
      handler({ export: "processOrders", event: {} }, context),
    ).rejects.toThrow(
      'No export of this module handles the event (scheduled invocation of processOrders). The scheduled invocation names the export "processOrders", which is not a schedule handler.',
    );
    expect(todos.processOrders).not.toHaveBeenCalled();
  });

  const scheduledEvent = {
    "detail-type": "Scheduled Event",
    time: "2026-11-02",
  };
  const sqsEvent = {
    Records: [{ eventSource: "aws:sqs", eventSourceARN: "arn:unmapped" }],
  };

  test("sends an event with no entry to the module's only handler of that kind", async () => {
    const run = vi.fn(async () => {});
    const handler = dispatcherWith({
      run: handle.eventBridgeScheduledEvent(run),
      getTodos: handle.apiRequest(() => json([])),
      formatDate: () => "2026-11-02",
      resource: {},
    });

    await handler(scheduledEvent, context);
    expect(run).toHaveBeenCalledWith(scheduledEvent, context);
  });

  test("does not send an event to a handler of another kind", async () => {
    const handler = dispatcherWith({
      getTodos: handle.apiRequest(() => json([])),
      resource: {},
    });

    await expect(handler(sqsEvent, context)).rejects.toThrow(
      "No export of this module handles the event (aws:sqs event from arn:unmapped). The module has no sqs handler, and the dispatch map has no entry for the event.",
    );
  });

  test("counts only exports made with handle as handlers", async () => {
    const handler = dispatcherWith({
      run: async () => "done",
      resource: {},
    });

    await expect(handler(scheduledEvent, context)).rejects.toThrow(
      "The module has no schedule handler",
    );
  });

  test("throws for an event with no entry when the module has several handlers of its kind", async () => {
    const handler = dispatcherWith(todos);

    await expect(
      handler(apiRequest("api-1", "GET /todos"), context),
    ).rejects.toThrow("the module has 2 api handlers: getTodos, createTodo");
  });

  test("throws for an event whose shape matches no kind of handler", async () => {
    const handler = dispatcherWith({
      run: handle.eventBridgeScheduledEvent(async () => {}),
    });

    await expect(handler({ anything: true }, context)).rejects.toThrow(
      "No export of this module handles the event (unrecognised event). Its shape doesn't match any kind of event that a handler takes.",
    );
  });

  test("throws when a scheduled invocation names an export the module doesn't have", async () => {
    const handler = dispatcherWith(todos, runtime);

    await expect(
      handler({ export: "resource", event: {} }, context),
    ).rejects.toThrow(
      'names the export "resource", which is not a schedule handler',
    );
  });
});

test("handlers are typed as references that infra can route to", () => {
  const getTodos = handle.apiRequest(() => json([]));
  // the generated module gives infra a reference in place of the handler
  const ref = { resource: lambda({ id: "todos", code }), export: "getTodos" };
  const asImported = ref as unknown as typeof getTodos;

  const todoRoute = router(api({ name: "a" })).get("/", asImported);
  expect(todoRoute.id).toBe("a-GET-/");
});

const code = { type: "file", path: "dist/runtime/todos/index.mjs" } as const;
