# Lambda Handlers

A Lambda function's code is a `handler` export in a runtime module. Lambda calls `handler` with each event. Notation doesn't wrap the handler and doesn't route events to it, so you write it with Lambda's own API and the types from `aws-lambda`.

The same module declares the function with `$lambda`. The declaration says which events the function receives, and it gives the handler its types and a small runtime API: `env()` and `decode()`. See [Lambda Declaration](./function-config.md) for the options.

```ts [runtime/orders.ts]
import { $lambda, sqs, type LambdaHandler } from "@notation/aws/lambda";

export const lambda = $lambda({
  id: "orders",
  event: () => sqs(),
});

export const handler: LambdaHandler<typeof lambda> = async (event) => {
  for (const record of event.Records) console.log(record.body);
};
```

The `$` marks a function that the build handles specially. `$lambda` must be called at the top level of the module, with one object literal. The build reads the call, and each build keeps only the options it needs. Functions without a `$`, such as `queue()` or `lambda()`, declare resources in infra.

`LambdaHandler<typeof lambda>` reads the event from the declaration. Here the event is `sqs()`, so `event` is typed as an `SQSEvent`.

**The build doesn't yet check `handler` against the declaration.** Without the `LambdaHandler<typeof lambda>` annotation, nothing stops you from writing an SQS handler in a module that declares an HTTP event. The RFC plans a build-time check for this, but it isn't built. Until then, annotate each handler.

## Handler types

`event` in the declaration chooses the type of the handler:

| `event`                               | `LambdaHandler<typeof lambda>`                                                                    |
| ------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `() => sqs()`                         | `(event: SQSEvent, context: Context) => SQSBatchResponse \| void` (or a promise)                  |
| `() => http()`                        | `(event: APIGatewayProxyEventV2, context: Context) => ApiGatewayResult` (or a promise)            |
| `() => http({ auth: jwt<Claims>() })` | `(event: APIGatewayJWTProxyEventV2<Claims>, context: Context) => ApiGatewayResult` (or a promise) |
| `() => scheduled()`                   | `(event: EventBridgeEvent<"Scheduled Event", unknown>, context: Context) => void` (or a promise)  |
| no `event`                            | `(event: unknown, context: Context) => unknown`                                                   |

`event` also decides where infra can wire the function: an SQS Lambda to a queue, an HTTP Lambda to a route, and a scheduled Lambda to a schedule. A Lambda with `http({ auth: jwt() })` can only be wired to a route with a JWT authorizer. A Lambda with no `event` can be wired to any of them. See [End-to-End Types](./types.md).

Notation has no event kind for DynamoDB streams. A function for another event source has no `event`, and its handler types the event itself.

## One handler for each function

A Lambda function has one entry point, so a module has one `handler`. A function that serves several routes reads the route from the event. For example, the `todos` function serves `GET /todos` and `GET /todos/count`, and branches on `event.routeKey`:

```ts [runtime/todos.ts]
import { $lambda, http, type LambdaHandler } from "@notation/aws/lambda";
import { api } from "./utils";

export const lambda = $lambda({
  id: "todos",
  timeout: 5,
  memory: 64,
  event: () => http(),
});

const todos = await api.get<any[]>("/todos");

export const handler: LambdaHandler<typeof lambda> = async (event) => {
  if (event.routeKey === "GET /todos/count") return todos.length;
  return todos;
};
```

`event.routeKey` holds the method and the path of the route, such as `GET /todos/count`. The top-level `await api.get(...)` runs once, when Lambda loads the module. It never runs at deploy time, because the infra build removes everything in the module except the declaration and the code that the declaration uses. See [Compiler](../internals/compiler.md#the-infra-build).

## Reading bound values with `env()`

The handler reads infra values, such as a queue's URL, through the declaration. The declaration binds each value to a name in `env`, and `lambda.env()` returns the values by name:

```ts [runtime/orders.ts]
import { $lambda, sqs, type LambdaHandler } from "@notation/aws/lambda";
import { orderQueue } from "infra/orders";

export const lambda = $lambda({
  id: "orders",
  event: () => sqs(),
  env: () => ({ ORDER_QUEUE_URL: orderQueue.url }),
});

export const handler: LambdaHandler<typeof lambda> = async (event) => {
  console.log("messages from", lambda.env().ORDER_QUEUE_URL);
};
```

Deploy sets `ORDER_QUEUE_URL` as an environment variable of the function. In the function, `env()` reads each name that the declaration binds from `process.env`, and throws if one of them is not set. A name that the declaration doesn't bind, such as `lambda.env().QUEUE_URL`, is a type error.

**The handler can't read `orderQueue.url` directly.** The runtime build leaves infra modules out of the function's bundle. If the handler uses `orderQueue`, the infra module stays in the bundle, and the build fails with the chain of imports that brought it in. See [Compiler](../internals/compiler.md#the-runtime-build).

## Validating bodies with `decode()`

`lambda.decode()` parses the JSON body of one item, and validates it with the schema in `event`. For an SQS Lambda the item is one record. For an HTTP Lambda the item is the request, and a base64 body is decoded first. The schema goes in `sqs(schema)` or `http({ body: schema })`:

```ts [runtime/orders.ts]
import {
  $lambda,
  DecodeError,
  sqs,
  type LambdaHandler,
} from "@notation/aws/lambda";
import { Order } from "./schema";

export const lambda = $lambda({
  id: "orders",
  event: () => sqs(Order),
});

export const handler: LambdaHandler<typeof lambda> = async (event) => {
  for (const record of event.Records) {
    try {
      const order = await lambda.decode(record);
      console.log("order", order.orderId);
    } catch (error) {
      if (!(error instanceof DecodeError)) throw error;
      console.error("invalid order", record.messageId, error.issues);
    }
  }
};
```

- `Order` is any [Standard Schema](https://standardschema.dev), such as a Zod or Valibot schema. `decode()` returns the schema's output type.
- Without a schema, as in `sqs()` or `http()`, `decode()` returns the parsed JSON as `unknown`.
- When the body is not JSON, or the schema rejects it, `decode()` throws a `DecodeError`. Its `issues` hold the schema's issues.
- A message that fails validation fails again on every retry, so the handler logs it and skips it. If the handler threw instead, Lambda would retry the whole batch until the queue's retention period ends.
- A scheduled Lambda, or a Lambda with no `event`, has no `decode()`. Calling it is a type error.

`decode()` only checks what the function receives. Nothing checks that a sender writes a body that matches the schema, and a value such as a `Date` doesn't survive `JSON.stringify` and `JSON.parse` as a `Date`.

## Responses

An HTTP handler can return a plain value, such as an object or an array. API Gateway sends a value that has no `statusCode` as a JSON body, with status 200:

```ts [runtime/todos.ts]
export const handler: LambdaHandler<typeof lambda> = async () => {
  return [{ id: 1, text: "Learn Notation" }];
};
```

To set the status code, headers or body yourself, return `{ statusCode, headers, body }`. API Gateway reads any returned object that has a `statusCode` this way, so wrap a value that has a `statusCode` field in a body of your own.
