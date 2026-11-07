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

`name` keys the queue in state, so changing it replaces the queue. In AWS, the queue is named `<app>--<stage>--<name>`, such as `my-app--prod--orders`. See [AWS names](../manual/project-config.md#aws-names). A FIFO queue's name must end in `.fifo`, and `fifo` can't change after the queue is created.

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

## `queue.consume(target)`

`consume` invokes a function with the queue's messages:

::code-group

```ts [infra/orders.ts]
import { queue } from "@notation/aws/sqs";
import { lambda as processOrders } from "runtime/orders.fn";

export const orderQueue = queue({ name: "orders" });
orderQueue.consume(() => processOrders, { batchSize: 5 });
```

```ts [runtime/orders.fn.ts]
import { createLambda, sqs, type LambdaHandler } from "@notation/aws/lambda";

export const lambda = createLambda({
  id: "orders",
  event: () => sqs(),
});

export const handler: LambdaHandler<typeof lambda> = async (event) => {
  for (const record of event.Records) console.log(record.body);
};
```

::

`processOrders` is the declaration from the runtime module `runtime/orders.fn.ts`. `consume` takes it as a function, `() => processOrders`, and calls the function when infra has finished loading. The declaration must have `event: () => sqs()`, or no `event`. See [Wiring a declaration](lambda.md#wiring-a-declaration). `consume` also takes a Lambda group from [`lambda()`](lambda.md#lambdaconfig), as it is.

`consume` changes two things, and the function's declaration doesn't mention the queue:

1. **The role's inline policy.** `consume` contributes a statement that allows `sqs:ReceiveMessage`, `sqs:DeleteMessage` and `sqs:GetQueueAttributes` on the queue to the function's [inline policy](lambda.md#inline-policy).
2. **An event source mapping**, `orders-orders-mapping`, which connects the queue to the function.

The mapping depends on the policy, even though it reads nothing from it. This matters because AWS checks the role's permissions when it creates the mapping, so the policy has to exist first. Notation retries the create while the new permissions propagate through IAM.

The mapping doesn't turn on `ReportBatchItemFailures`. So if the handler returns `{ batchItemFailures }`, Lambda ignores it, and a batch either succeeds or fails as a whole.

### Options

```ts [@notation/aws/sqs]
type ConsumeOptions = {
  batchSize?: number;
  maxBatchingWindow?: number;
};
```

When you remove `batchSize` or `maxBatchingWindow`, Notation sets the mapping back to the Lambda defaults: a batch size of 10 and a batching window of 0 seconds.

### Validating messages

`sqs(schema)` gives the declaration a [Standard Schema](https://standardschema.dev) for the message bodies. The handler validates each record with `lambda.decode(record)`, which parses the body as JSON and returns the schema's output type. See [Validating bodies with `decode()`](../manual/functions.md#validating-bodies-with-decode).

The queue doesn't carry the schema, and nothing checks the messages that a sender writes. To send messages, use `@aws-sdk/client-sqs` in your own code.

### Several queues

Each queue contributes its own statement and its own mapping, so two queues can feed one function:

```ts [infra/orders.ts]
import { lambda as processOrders } from "runtime/orders.fn";

orderQueue.consume(() => processOrders);
refundQueue.consume(() => processOrders);
```

The function's policy then has two statements. When you delete the `refundQueue.consume` line, its statement and mapping go with it, and the next deploy updates the policy and deletes the mapping.

The function's one `handler` receives the messages of both queues. Each record's `eventSourceARN` names its queue. To compare it with a queue in the handler, bind the queue's ARN in `env`:

```ts [runtime/orders.fn.ts]
import { createLambda, sqs, type LambdaHandler } from "@notation/aws/lambda";
import { refundQueue } from "infra/orders";

export const lambda = createLambda({
  id: "orders",
  event: () => sqs(),
  env: () => ({ REFUND_QUEUE_ARN: refundQueue.arn }),
});

export const handler: LambdaHandler<typeof lambda> = async (event) => {
  for (const record of event.Records) {
    const kind = record.eventSourceARN === lambda.env().REFUND_QUEUE_ARN ? "refund" : "order";
    console.log(kind, record.body);
  }
};
```

A queue can feed a given function once. A second `consume` with the same function throws.

## `queue.grant(actions)`

`grant` returns a policy statement for the queue. A declaration adds it to its function's role with the `policy` option. For example, to let the `orders` function send messages to `refundQueue`, and read the queue's URL:

```ts [runtime/orders.fn.ts]
import { createLambda, sqs } from "@notation/aws/lambda";
import { refundQueue } from "infra/orders";

export const lambda = createLambda({
  id: "orders",
  event: () => sqs(),
  policy: () => [refundQueue.grant(["SendMessage"])],
  env: () => ({ REFUND_QUEUE_URL: refundQueue.url }),
});
```

For a Lambda group from `lambda()`, contribute the statement to the group's inline policy:

```ts [infra/orders.ts]
import { lambda } from "@notation/aws/lambda";

const importer = lambda({
  id: "order-importer",
  code: { type: "file", path: "external/importer.mjs" },
});

importer.policy.contribute({
  PolicyDocument: { Statement: [orderQueue.grant(["SendMessage"])] },
});
```

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
