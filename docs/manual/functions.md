# Lambda Handlers

A Lambda function's code is a `handler` export in a runtime module. Lambda calls `handler` with each event. Notation doesn't wrap the handler and doesn't route events to it, so you write it with Lambda's own API and the types from `aws-lambda`.

The same module declares the function with `$lambda`. The declaration says which events the function receives, and it gives the handler its types and a small runtime API: `env()` and `decode()`. See [Lambda Declaration](./function-config.md) for the options.

```ts [runtime/orders.ts]
import { $lambda, sqs, type LambdaHandler } from "@notation/aws/lambda";
import { Order } from "shared/schema";

export const lambda = $lambda({
  id: "orders",
  event: () => sqs.schema(Order),
});

export const handler: LambdaHandler<typeof lambda> = async (event) => {
  for (const record of event.Records) console.log(record.body);
};
```

The `$` marks a function that the build handles specially. `$lambda` must be called at the top level of the module, with one object literal. The build reads the call, and each build keeps only the options it needs. Functions without a `$`, such as `queue()` or `lambda()`, declare resources in infra.

`LambdaHandler<typeof lambda>` reads the event from the declaration. Here the event is `sqs.schema(Order)`, so `event` is typed as an `SQSEvent`.

**The build doesn't yet check `handler` against the declaration.** Without the `LambdaHandler<typeof lambda>` annotation, nothing stops you from writing an SQS handler in a module that declares an API Gateway event. The RFC plans a build-time check for this, but it isn't built. Until then, annotate each handler.

## Handler types

`event` in the declaration chooses the type of the handler:

| `event`                                                                             | `LambdaHandler<typeof lambda>`                                                                       |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `() => sqs.bind(queue)` or `() => sqs.schema(schema)`                               | `(event: SQSEvent, context: Context) => SQSBatchResponse \| void` (or a promise)                     |
| `() => apiGateway.schema(body)`, or `defineRoute()` with no `auth`                  | `(event: APIGatewayProxyEventV2, context: Context) => ApiGatewayResult` (or a promise)               |
| `() => apiGateway.schema(body).authSchema(claims?)`, or `defineRoute()` with `auth` | `(event: APIGatewayJWTProxyEventV2<JwtClaims>, context: Context) => ApiGatewayResult` (or a promise) |
| `() => eventBridge.schema(null)` or `() => eventBridge.defineSchedule(options)`     | `(event: EventBridgeEvent<"Scheduled Event", unknown>, context: Context) => void` (or a promise)     |
| no `event`                                                                          | `(event: unknown, context: Context) => unknown`                                                      |

`event` also decides where infra can wire the function: an `sqs` Lambda to a queue, an `apiGateway` Lambda to a route, and an `eventBridge` Lambda to a schedule. A Lambda with `.authSchema()` or `auth` can only be wired to a route with a JWT authorizer, and a Lambda without either only to a route without an authorizer. A Lambda with no `event` can be wired to any of them. See [End-to-End Types](./types.md).

Notation has no event kind for DynamoDB streams. A function for another event source has no `event`, and its handler types the event itself.

## One handler for each function

A Lambda function has one entry point, so a module has one `handler`. A function that serves several routes reads the route from the event. For example, the `todos` function serves `GET /todos` and `GET /todos/count`, and branches on `event.routeKey`:

```ts [runtime/todos.ts]
import { $lambda, apiGateway, type LambdaHandler } from "@notation/aws/lambda";
import { api } from "./utils";

export const lambda = $lambda({
  id: "todos",
  timeout: 5,
  memory: 64,
  event: () => apiGateway.schema(null),
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
  event: () => sqs.bind(orderQueue),
  env: () => ({ ORDER_QUEUE_URL: orderQueue.url }),
});

export const handler: LambdaHandler<typeof lambda> = async (event) => {
  console.log("messages from", lambda.env().ORDER_QUEUE_URL);
};
```

Deploy sets `ORDER_QUEUE_URL` as an environment variable of the function. In the function, `env()` reads each name that the declaration binds from `process.env`, and throws if one of them is not set. A name that the declaration doesn't bind, such as `lambda.env().QUEUE_URL`, is a type error.

**The handler can't read `orderQueue.url` directly.** The runtime build leaves infra modules out of the function's bundle. If the handler uses `orderQueue`, the infra module stays in the bundle, and the build fails with the chain of imports that brought it in. See [Compiler](../internals/compiler.md#the-runtime-build).

## Validating bodies with `decode()`

`lambda.decode()` parses the JSON body of one item, and validates it with the schema of `event`. It returns the item with `body` in place of the JSON string. For an SQS Lambda the item is one record, and the schema is the `schema` of the queue in `sqs.bind(queue)`, or the schema in `sqs.schema(schema)`. For an API Gateway Lambda the item is the request, the schema goes in `apiGateway.schema(body)` or in the `schema` option of `defineRoute()`, and a base64 body is decoded first:

```ts [runtime/orders.ts]
import {
  $lambda,
  DecodeError,
  sqs,
  type LambdaHandler,
} from "@notation/aws/lambda";
import { orderQueue } from "infra/orders";

export const lambda = $lambda({
  id: "orders",
  event: () => sqs.bind(orderQueue),
});

export const handler: LambdaHandler<typeof lambda> = async (event) => {
  for (const record of event.Records) {
    try {
      const { body: order } = await lambda.decode(record);
      console.log("order", order.orderId);
    } catch (error) {
      if (!(error instanceof DecodeError)) throw error;
      console.error("invalid order", record.messageId, error.issues);
    }
  }
};
```

- The infra module declares `orderQueue` with `queue({ id: "orders", schema: Order })`. `Order` is any [Standard Schema](https://standardschema.dev), such as a Zod or Valibot schema. `body` in the result of `decode()` has the schema's output type. The other fields of the record keep their types.
- `Order` belongs in a shared module (`files.shared`), such as `shared/schema.ts`, because the function loads it. It can't be in an infra or runtime module. The runtime build replaces `orderQueue` with `{ schema: Order }`. See [Validating messages](../resources/sqs.md#validating-messages).
- A function that infra maps queues to declares the schema itself, with `sqs.schema(Order)`. `eventSourceMapping()` checks that each queue it maps has the same schema. See [`eventSourceMapping(config)`](../resources/sqs.md#eventsourcemappingconfig).
- Every queue has a schema, so `decode()` always validates a message. A queue that takes any JSON body declares a schema such as `v.unknown()`, and `body` is the parsed JSON as `unknown`. See [`queue(config)`](../resources/sqs.md#queueconfig).
- An API Gateway Lambda always names its body schema. A body schema of `null`, as in `apiGateway.schema(null)` or `defineRoute({ ..., schema: null })`, means the requests have no body. `body` is `undefined`, and `decode()` throws a `DecodeError` for a request with a body.
- With a body schema, a request with an empty body is validated as `undefined`, so the schema decides whether the body may be left out.
- A request body that is not JSON, or whose parsed value the schema rejects, is validated as a string. So a route that takes text, such as a form body, declares a string schema, such as `v.string()`. See [Request bodies](../resources/api-gateway.md#request-bodies).
- A request through a JWT authorizer, to a Lambda with `.authSchema()` or `defineRoute({ auth })`, also gets a top-level `claims` field. `decode()` validates the claims with the claims schema, if there is one, and throws a `DecodeError` for claims that the schema rejects. See [Claims in `decode()`](../resources/api-gateway.md#claims-in-decode).
- When the body is not valid, `decode()` throws a `DecodeError`. Its `issues` hold the schema's issues.
- A message that fails validation fails again on every retry, so the handler logs it and skips it. If the handler threw instead, Lambda would retry the whole batch until the queue's retention period ends.
- An `eventBridge` Lambda, or a Lambda with no `event`, has no `decode()`. Calling it is a type error.

`decode()` only checks what the function receives. Nothing checks that a sender writes a body that matches the schema, and a value such as a `Date` doesn't survive `JSON.stringify` and `JSON.parse` as a `Date`.

## Responses

An HTTP handler can return a plain value, such as an object or an array. API Gateway sends a value that has no `statusCode` as a JSON body, with status 200:

```ts [runtime/todos.ts]
export const handler: LambdaHandler<typeof lambda> = async () => {
  return [{ id: 1, text: "Learn Notation" }];
};
```

To set the status code, headers or body yourself, return `{ statusCode, headers, body }`. API Gateway reads any returned object that has a `statusCode` this way, so wrap a value that has a `statusCode` field in a body of your own.
