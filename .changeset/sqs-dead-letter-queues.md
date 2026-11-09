---
"@notation/aws": minor
"@notation/aws.iac": minor
---

`queue()` takes a dead-letter queue, a message size and the FIFO settings, and SQS mappings can report failed messages and limit concurrency.

```ts
export const orderDeadLetterQueue = queue({ id: "orders-dlq", schema: Order });

export const orderQueue = queue({
  id: "orders",
  schema: Order,
  deadLetterQueue: { queue: orderDeadLetterQueue, maxReceiveCount: 3 },
});

export const lambda = $lambda({
  id: "orders",
  event: () => sqs.bind(orderQueue, { reportBatchItemFailures: true }),
});
```

- `deadLetterQueue: { queue, maxReceiveCount }` sets the queue's `RedrivePolicy`. The queue depends on the dead-letter queue, which deploys first. `queue()` throws when one queue is FIFO and the other is standard. Removing `deadLetterQueue` removes the policy.
- `maximumMessageSize` sets `MaximumMessageSize`. Removing it sets the queue back to 1,048,576 bytes.
- `contentBasedDeduplication`, `deduplicationScope` and `fifoThroughputLimit` set the FIFO attributes of the same names. `queue()` throws when a standard queue sets one of them, and when `fifoThroughputLimit: "perMessageGroupId"` comes without `deduplicationScope: "messageGroup"`. Removing one sets it back to the SQS default.
- `sqs.bind()` and `eventSourceMapping()` take `reportBatchItemFailures`, `maximumConcurrency` and `enabled`. `reportBatchItemFailures: true` turns on `ReportBatchItemFailures`, so Lambda reads `{ batchItemFailures }` from the handler's result. `maximumConcurrency` sets the mapping's `ScalingConfig`. `enabled: false` pauses the mapping. Removing an option sets the mapping back to the Lambda default.
- In `@notation/aws.iac`, `sqs.Queue` takes `MaximumMessageSize`, `RedrivePolicy`, `ContentBasedDeduplication`, `DeduplicationScope` and `FifoThroughputLimit`. `lambda.LambdaEventSourceMapping` takes `FunctionResponseTypes` and `ScalingConfig`.
