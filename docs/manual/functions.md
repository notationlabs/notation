# Lambda Handlers

A handler is a function that a Lambda function calls with an event. A runtime module makes each handler with the `handle` that [`lambda()`](./function-config.md) returns, and exports it:

```ts [runtime/orders.fn.ts]
import { lambda } from "@notation/aws/lambda" with { type: "infra" };

const { handle } = lambda({ id: "orders", timeout: 5, memory: 64 });

export const processOrders = handle.sqsEvent((event) => {
  for (const record of event.Records) console.log("order", record.body);
});
```

Each method of `handle` takes one kind of event, and types the handler's `event` argument to match it. `handle.sqsEvent` types `event` as an SQS event, so `event.Records` is typed.

The `handle.*` call does two things:

1. **It marks the function as a handler.** Infra imports the module `with { type: "runtime" }`, and sees each handler as a `RuntimeRef`. Infra APIs such as `router.get` and `queue.consume` take a `RuntimeRef` of the event they send. See [End-to-End Types](./types.md).
2. **It ties the handler to the function.** Every handler that one `handle` makes runs in the same Lambda function, which sends each event to the right handler. See [Dispatch](../resources/lambda.md#dispatch).

In runtime code and tests, a handler is the plain function that you passed to `handle.*`. A test calls it directly. See [Testing Handlers](./testing.md).

The examples below leave out the `lambda()` call.

## `handle.apiRequest`

For API Gateway HTTP API events.

```ts [runtime/users.fn.ts]
import { json } from "@notation/aws/lambda.fn";

export const getUsers = handle.apiRequest((event) => {
  return json([{ id: 1, name: "Alice" }]);
});
```

## `handle.jwtAuthorizedApiRequest`

For API Gateway events with JWT authorization. Accepts a generic for JWT claims.

```ts [runtime/user.fn.ts]
import { json } from "@notation/aws/lambda.fn";

type Claims = { sub: string; email: string };

export const getProfile = handle.jwtAuthorizedApiRequest<Claims>((event) => {
  const { sub } = event.requestContext.authorizer.jwt.claims;
  return json({ sub });
});
```

## `handle.eventBridgeScheduledEvent`

For EventBridge scheduled events.

```ts [runtime/cleanup.fn.ts]
export const runCleanup = handle.eventBridgeScheduledEvent((event) => {
  console.log("Running scheduled cleanup");
});
```

## `handle.dynamoDbStream`

For DynamoDB stream events. Notation has no DynamoDB stream binding yet, so the function's dispatcher has no entry for stream records and throws when it receives them.

```ts [runtime/records.fn.ts]
export const onRecordChange = handle.dynamoDbStream((event) => {
  for (const record of event.Records) {
    console.log("Record changed:", record.dynamodb);
  }
});
```

## `handle.dynamoDbBatch`

For DynamoDB batch events.

## `handle.sqsEvent`

For SQS events.

```ts [runtime/orders.fn.ts]
export const processOrders = handle.sqsEvent((event) => {
  for (const record of event.Records) {
    console.log("Message:", record.body);
  }
});
```

## `handle.sqsBatch`

For SQS batch events.

## `json`

A helper that `@notation/aws/lambda.fn` exports, for returning JSON responses from API Gateway handlers. It returns `{ statusCode: 200, body }`, with the result as a JSON string in `body`.

```ts [runtime/todos.fn.ts]
import { json } from "@notation/aws/lambda.fn";

export const getTodos = handle.apiRequest(() => {
  return json({ hello: "world" });
});
```

`@notation/aws/lambda.fn` is the runtime half of `@notation/aws/lambda`. Runtime code imports it without an attribute.

## Reading infra values

A handler can read values from infra, such as the URL of a queue, by importing the infra module `with { type: "infra" }`. See [Reading Infra Values](./infra-values.md).
