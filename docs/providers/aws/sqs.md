# AWS SQS

Decouple background jobs and asynchronous workflows with Amazon SQS standard and FIFO queues, dead-letter queues, schema-checked JSON payloads, and automatic Lambda consumer subscriptions.

For AWS credential and region setup, see [AWS Overview](./overview.md).

Wire a producer Lambda, a primary queue backed by a dead-letter queue, and a consumer Lambda using a shared message schema:

::code-group

```ts [shared/schema.ts]
import * as v from "valibot";

export const Order = v.object({
  orderId: v.string(),
  quantity: v.pipe(v.number(), v.integer(), v.minValue(1)),
});

export const DeadLetter = v.unknown();
```

```ts [infra/orders.ts]
import { queue } from "@notation/aws/sqs";
import { DeadLetter, Order } from "../shared/schema";

export const orderDeadLetterQueue = queue({
  id: "orders-dlq",
  schema: DeadLetter,
});

export const orderQueue = queue({
  id: "orders",
  schema: Order,
  deadLetterQueue: {
    queue: orderDeadLetterQueue,
    maxReceiveCount: 3,
  },
});
```

```ts [runtime/create-order.ts]
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { $lambda, type LambdaHandler } from "@notation/aws/lambda";
import { orderQueue } from "../infra/orders";

const sqsClient = new SQSClient();

export const lambda = $lambda({
  id: "create-order",
  env: () => ({ ORDER_QUEUE_URL: orderQueue.url }),
  policy: () => [orderQueue.grant(["SendMessage"])],
});

export const handler: LambdaHandler<typeof lambda> = async (event) => {
  await sqsClient.send(
    new SendMessageCommand({
      QueueUrl: lambda.env().ORDER_QUEUE_URL,
      MessageBody: JSON.stringify(event),
    }),
  );
};
```

```ts [runtime/orders.ts]
import { $lambda, sqs, type LambdaHandler } from "@notation/aws/lambda";
import { orderQueue } from "../infra/orders";

export const lambda = $lambda({
  id: "orders",
  event: () => sqs.bind(orderQueue),
});

export const handler: LambdaHandler<typeof lambda> = async (event) => {
  for (const record of event.Records) {
    const { body: order } = await lambda.decode(record);
    console.log("processing order", order.orderId, order.quantity);
  }
};
```

::

`sqs.bind()` automatically creates the event source mapping and grants `sqs:ReceiveMessage`, `sqs:DeleteMessage`, and `sqs:GetQueueAttributes` on `orderQueue`. Note that `orderQueue.url` and `orderQueue.arn` are deploy-time output refs (see [Outputs & Contributions](../../core/outputs-and-contributions.md)), so bind them explicitly in `env` if your handler needs to send messages.

## Partial batch failures

Enable `reportBatchItemFailures: true` so your handler can catch `DecodeError` per record and return `{ batchItemFailures }`, letting SQS delete valid messages while retrying only failed ones until they move to the dead-letter queue:

```ts [runtime/orders.ts]
import { $lambda, DecodeError, sqs, type LambdaHandler } from "@notation/aws/lambda";
import { orderQueue } from "../infra/orders";

export const lambda = $lambda({
  id: "orders",
  event: () => sqs.bind(orderQueue, { batchSize: 5, reportBatchItemFailures: true }),
});

export const handler: LambdaHandler<typeof lambda> = async (event) => {
  const batchItemFailures: { itemIdentifier: string }[] = [];
  for (const record of event.Records) {
    try {
      const { body: order } = await lambda.decode(record);
      console.log("order", order.orderId);
    } catch (error) {
      if (!(error instanceof DecodeError)) throw error;
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures };
};
```

Without `reportBatchItemFailures: true`, a `$lambda` bound with `sqs.bind()` returns `void`: returning deletes the whole batch, while throwing retries the whole batch.

## Infra-owned subscriptions

Use `sqs.schema()` in a runtime module with `eventSourceMapping()` in `infra/` to subscribe one Lambda to multiple queues, wire a `lambda()` group, or keep runtime modules free of `infra/` imports:

::code-group

```ts [runtime/refunds.ts]
import { $lambda, sqs, type LambdaHandler } from "@notation/aws/lambda";
import { Refund } from "../shared/schema";

export const lambda = $lambda({
  id: "refunds",
  event: () => sqs.schema(Refund),
});

export const handler: LambdaHandler<typeof lambda> = async (event) => {
  for (const record of event.Records) {
    const { body: refund } = await lambda.decode(record);
    console.log("refund for", refund.orderId, refund.reason);
  }
};
```

```ts [infra/orders.ts]
import { eventSourceMapping } from "@notation/aws/lambda";
import { queue } from "@notation/aws/sqs";
import { lambda as refunds } from "../runtime/refunds";
import { Refund } from "../shared/schema";

export const refundQueue = queue({ id: "refunds", schema: Refund });

eventSourceMapping({
  source: refundQueue,
  target: () => refunds,
  batchSize: 5,
});
```

::

`queue()` and `sqs.schema()` must share the exact same validator instance imported from `shared/`. Passing a `$lambda` declared with `sqs.bind()` to `eventSourceMapping()`, or mapping the same queue to the same Lambda twice, throws.

## FIFO queues

Set `fifo: true` to create a FIFO queue with content-based deduplication or per-message-group high throughput:

```ts [infra/ledger.ts]
import { queue } from "@notation/aws/sqs";
import { LedgerEntry } from "../shared/schema";

export const ledgerQueue = queue({
  id: "ledger",
  fifo: true,
  schema: LedgerEntry,
  contentBasedDeduplication: true,
  deduplicationScope: "messageGroup",
  fifoThroughputLimit: "perMessageGroupId",
});
```

Omit `.fifo` from `id` because dots fail name-safe validation; Notation appends `.fifo` to the physical AWS queue name automatically within SQS's 80-character limit (see [Physical Names](../../core/physical-names.md)).

## Reference

### Queue options

`queue(config)` from `@notation/aws/sqs` accepts `QueueConfig`:

| Option | Description |
| :--- | :--- |
| `id` | Required `IdOption<Id>` string identifying the queue |
| `schema` | Required `StandardSchemaV1` validator for each message's JSON body |
| `fifo` | Optional `boolean` creating a `.fifo` queue; defaults to `false` |
| `visibilityTimeout` | Optional `number` in seconds from `0` to `43200`; defaults to `30` |
| `messageRetentionPeriod` | Optional `number` in seconds from `60` to `1209600`; defaults to `345600` |
| `delaySeconds` | Optional `number` in seconds from `0` to `900`; defaults to `0` |
| `receiveMessageWaitTime` | Optional `number` for long-polling seconds from `0` to `20`; defaults to `0` |
| `maximumMessageSize` | Optional `number` in bytes from `1024` to `1048576`; defaults to `1048576` |
| `deadLetterQueue` | Optional `{ queue: QueueGroup \| Input<string>, maxReceiveCount: number }` config |
| `contentBasedDeduplication` | Optional `boolean` for FIFO SHA-256 body deduplication; defaults to `false` |
| `deduplicationScope` | Optional `"queue" \| "messageGroup"` FIFO scope; defaults to `"queue"` |
| `fifoThroughputLimit` | Optional `"perQueue" \| "perMessageGroupId"` FIFO quota; defaults to `"perQueue"` |

`id` must be `1` to `64` characters matching `[A-Za-z0-9_-]`; changing `id` replaces the queue. Pass `v.unknown()` as `schema` to accept arbitrary JSON. `fifo` is immutable after creation, and `deadLetterQueue.maxReceiveCount` accepts `1` to `1000`. Removing an optional attribute in a later deployment resets it to its SQS default, and removing `deadLetterQueue` clears `RedrivePolicy`.

### QueueGroup properties

`queue()` returns a `QueueGroup` exposing:

| Property | Description |
| :--- | :--- |
| `url` | `OutputRef<string>` resolving to the deployed `QueueUrl` |
| `arn` | `OutputRef<string>` resolving to the deployed `QueueArn` |
| `schema` | Standard Schema validator passed to `queue()` |
| `id` | Logical `string` queue ID |
| `queue` | Underlying `@notation/aws/resources` `sqs.Queue` resource |
| `grant(actions)` | Helper returning an IAM `Allow` `PolicyStatement` scoped to `queue.arn` |

### Batch options

Both `sqs.bind(queue, options)` and `eventSourceMapping({ source, target, ...options })` accept `SqsOptions`:

| Option | Description |
| :--- | :--- |
| `batchSize` | Optional `number` of records per batch; defaults to `10` |
| `maximumBatchingWindow` | Optional `number` of wait seconds before invoking; defaults to `0` |
| `reportBatchItemFailures` | Optional `boolean` enabling `{ batchItemFailures }` responses; defaults to `false` |
| `maximumConcurrency` | Optional `number` of concurrent Lambda instances from `2` to `1000` |
| `enabled` | Optional `boolean` controlling polling; defaults to `true` |

`batchSize` accepts `1` to `10000` on standard queues (values over `10` require `maximumBatchingWindow >= 1`) and `1` to `10` on FIFO queues. `maximumBatchingWindow` accepts `0` to `300` on standard queues and throws if non-zero on FIFO queues. `sqs.schema()` permits `SQSBatchResponse | void` by default.

### FIFO validation

Notation validates FIFO and dead-letter queue rules at declaration time:

| Rule | Behavior |
| :--- | :--- |
| FIFO-only options | Setting `contentBasedDeduplication`, `deduplicationScope`, or `fifoThroughputLimit` without `fifo: true` throws |
| High-throughput FIFO | Setting `fifoThroughputLimit: "perMessageGroupId"` without `deduplicationScope: "messageGroup"` throws |
| Dead-letter queue type | Primary and dead-letter queues must both be standard or both be FIFO |

### IAM grants

`queue.grant(actions)` accepts an array of `SqsAction`:

| Action | Description |
| :--- | :--- |
| `"SendMessage"` | Send messages to the queue |
| `"ReceiveMessage"` | Receive messages from the queue |
| `"DeleteMessage"` | Delete processed messages from the queue |
| `"ChangeMessageVisibility"` | Extend or reset message visibility timeouts |
| `"GetQueueAttributes"` | Read queue metadata and approximate counts |
| `"GetQueueUrl"` | Resolve queue URL by name |
| `"PurgeQueue"` | Delete all messages in the queue |

`sqs.bind()` and `eventSourceMapping()` automatically grant `ReceiveMessage`, `DeleteMessage`, and `GetQueueAttributes` to the consumer Lambda's execution role.

### Message decoding

Calling `await lambda.decode(record)` on an `SQSRecord` parses `record.body` as JSON, validates against the queue schema, and returns `{ ...record, body }`. Invalid JSON or schema mismatches throw `DecodeError` (`part: "body"`, with validation `issues`); even permissive schemas such as `v.unknown()` reject non-JSON bodies.

### Standalone handler types

When deploying external SQS handlers with `lambda()`, `@notation/aws/lambda` exports:

| Type | Description |
| :--- | :--- |
| `SqsHandler` | `(event: SQSEvent, context: Context) => void \| Promise<void>` |
| `SqsBatchHandler` | `(event: SQSBatchResponse, context: Context) => void \| Promise<void>` |
