# Lambda Handlers

`@notation/aws/lambda.fn` exports typed handler wrappers for each Lambda event source.

A handler is an export of a [runtime module](./file-conventions.md#runtime-modules). The examples below leave out the module's `resource` export. All the handlers in one module run in one Lambda function, which sends each event to the right handler. See [Dispatch](../resources/lambda.md#dispatch). Export each handler through a `handle.*` wrapper: the wrapper marks the function as a handler, and gives infra code the handler's type.

## `handle.apiRequest`

For API Gateway HTTP API events.

```ts [runtime/todos.fn.ts]
import { handle } from "@notation/aws/lambda.fn";

export const getUsers = handle.apiRequest((event) => {
  return [{ id: 1, name: "Alice" }];
});
```

## `handle.jwtAuthorizedApiRequest`

For API Gateway events with JWT authorization. Accepts a generic for JWT claims.

```ts [runtime/user.fn.ts]
import { handle } from "@notation/aws/lambda.fn";

type Claims = { sub: string; email: string };

export const getProfile = handle.jwtAuthorizedApiRequest<Claims>((event) => {
  const { sub } = event.requestContext.authorizer.jwt.claims;
  return { sub };
});
```

## `handle.eventBridgeScheduledEvent`

For EventBridge scheduled events.

```ts [runtime/cleanup.fn.ts]
import { handle } from "@notation/aws/lambda.fn";

export const runCleanup = handle.eventBridgeScheduledEvent((event) => {
  console.log("Running scheduled cleanup");
});
```

## `handle.dynamoDbStream`

For DynamoDB stream events. Notation has no DynamoDB stream binding yet, so the function's dispatcher has no entry for stream records and throws when it receives them.

```ts [runtime/records.fn.ts]
import { handle } from "@notation/aws/lambda.fn";

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

```ts [runtime/message.fn.ts]
import { handle } from "@notation/aws/lambda.fn";

export const processMessage = handle.sqsEvent((event) => {
  for (const record of event.Records) {
    console.log("Message:", record.body);
  }
});
```

## `handle.sqsBatch`

For SQS batch events.

## Responses

An API handler can return a plain value, such as an object or an array. API Gateway sends a value that has no `statusCode` as a JSON body, with status 200:

```ts [runtime/todos.fn.ts]
import { handle } from "@notation/aws/lambda.fn";

export const getTodos = handle.apiRequest(() => {
  return [{ id: 1, text: "Learn Notation" }];
});
```

To set the status code, headers or body yourself, return `{ statusCode, headers, body }`. API Gateway reads any returned object that has a `statusCode` this way, so wrap a value that has a `statusCode` field in a body of your own.
