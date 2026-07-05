# Lambda Handlers

`@notation/aws/lambda.fn` exports typed handler wrappers for each Lambda event source.

## `handle.apiRequest`

For API Gateway HTTP API events.

```ts [runtime/todos.fn.ts]
import { handle, json } from "@notation/aws/lambda.fn";

export const getUsers = handle.apiRequest((event) => {
  return json([{ id: 1, name: "Alice" }]);
});
```

## `handle.jwtAuthorizedApiRequest`

For API Gateway events with JWT authorization. Accepts a generic for JWT claims.

```ts [runtime/user.fn.ts]
import { handle, json } from "@notation/aws/lambda.fn";

type Claims = { sub: string; email: string };

export const getProfile = handle.jwtAuthorizedApiRequest<Claims>((event) => {
  const { sub } = event.requestContext.authorizer.jwt.claims;
  return json({ sub });
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

For DynamoDB stream events.

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

## `json`

Helper for returning JSON responses from API Gateway handlers.

```ts [runtime/todos.fn.ts]
import { json } from "@notation/aws/lambda.fn";

export const getTodos = handle.apiRequest(() => {
  return json({ hello: "world" });
});
```
