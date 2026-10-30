# SQS

`@notation/aws/sqs` creates SQS queues and connects them to Lambda functions.

## `queue(config)`

```ts [infra/orders.ts]
import { queue } from "@notation/aws/sqs";

export const orderQueue = queue({ name: "orders" });
```

### Config

```ts [@notation/aws/sqs]
type QueueConfig = {
  name: string;
  fifo?: boolean;
  visibilityTimeout?: number;
  messageRetentionPeriod?: number;
  delaySeconds?: number;
  receiveMessageWaitTime?: number;
};
```

`name` names the queue and keys it in state, so changing it replaces the queue. A FIFO queue's name must end in `.fifo`, and `fifo` can't change after the queue is created.

The other settings can change in place. When you remove one, Notation sets it back to the value SQS gives a new queue, because SQS can't unset a queue attribute:

| Setting                  | SQS attribute                   | Default            |
| ------------------------ | ------------------------------- | ------------------ |
| `visibilityTimeout`      | `VisibilityTimeout`             | 30 seconds         |
| `messageRetentionPeriod` | `MessageRetentionPeriod`        | 345,600 s (4 days) |
| `delaySeconds`           | `DelaySeconds`                  | 0                  |
| `receiveMessageWaitTime` | `ReceiveMessageWaitTimeSeconds` | 0                  |

SQS doesn't let you reuse a deleted queue's name for 60 seconds, so a replacement waits and retries the create until SQS accepts the name.

### `arn` and `url`

`orderQueue.arn` and `orderQueue.url` are output values: they don't exist until AWS creates the queue, but you can place them in another resource's config now. Notation makes that resource depend on the queue and fills in the real value at deploy. See [Output values](../internals/resource.md#output-values).

An output value can only be placed whole. Turning it into a string, for example in a template string, throws. To build a value from the queue's ARN, contribute a function that receives `orderQueue.queue` as a dep; see [Function contributions](../internals/resource.md#function-contributions).

## `queue.consume(handler)`

`consume` invokes a function with the queue's messages:

::code-group

```ts [infra/orders.ts]
import { queue } from "@notation/aws/sqs";
import { processOrders } from "runtime/orders.fn";

export const orderQueue = queue({ name: "orders" });
orderQueue.consume(processOrders, { batchSize: 5 });
```

```ts [runtime/orders.fn.ts]
import { LambdaConfig, handle } from "@notation/aws/lambda.fn";

export const processOrders = handle.sqsEvent(async (event) => {
  for (const record of event.Records) console.log(record.body);
});

export const config: LambdaConfig = {
  service: "aws/lambda",
  id: "orders",
};
```

::

The handler import from a `.fn.ts` file becomes a Lambda group, as it does for [API Gateway routes](api-gateway.md). `consume` then changes two things, and the function's own config doesn't mention the queue:

1. **The role's inline policy.** `consume` contributes a statement that allows `sqs:ReceiveMessage`, `sqs:DeleteMessage` and `sqs:GetQueueAttributes` on the queue to the function's [inline policy](lambda.md#inline-policy).
2. **An event source mapping**, `orders-orders-processOrders-mapping`, which connects the queue to the function.

The mapping depends on the policy, even though it reads nothing from it. This matters because AWS checks the role's permissions when it creates the mapping, so the policy has to exist first. Notation retries the create while the new permissions propagate through IAM.

### Options

```ts [@notation/aws/sqs]
type ConsumeOptions = {
  batchSize?: number;
  maxBatchingWindow?: number;
};
```

When you remove `batchSize` or `maxBatchingWindow`, Notation sets the mapping back to the Lambda defaults: a batch size of 10 and a batching window of 0 seconds.

### Several queues

Each queue contributes its own statement, so two queues can feed one function:

```ts [infra/orders.ts]
orderQueue.consume(processOrders);
refundQueue.consume(processOrders);
```

The function's policy then has two statements. When you delete the `refundQueue.consume` line, its statement and mapping go with it, and the next deploy updates the policy and deletes the mapping.

A queue can feed a given function once: a second `consume` with the same function throws.

## `queue.grant(actions)`

`grant` returns a policy statement for the queue. Contribute it to a Lambda group's inline policy to give the function other access, such as sending messages:

```ts [infra/orders.ts]
import { lambda } from "@notation/aws/lambda";

const importer = lambda({
  id: "order-importer",
  handler: "handler",
  code: { type: "file", path: "external/importer.mjs" },
});

importer.policy.contribute({
  PolicyDocument: { Statement: [orderQueue.grant(["SendMessage"])] },
});
```

A handler imported from a `.fn.ts` file is typed as the handler, not as a Lambda group, so this needs a group from `lambda()`.

```ts [@notation/aws/sqs]
type SqsAction =
  | "SendMessage"
  | "ReceiveMessage"
  | "DeleteMessage"
  | "ChangeMessageVisibility"
  | "GetQueueAttributes"
  | "GetQueueUrl"
  | "PurgeQueue";
```
