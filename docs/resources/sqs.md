# SQS

`@notation/aws/sqs` creates SQS queues. A Lambda function reads a queue in one of two ways: its declaration names the queue with `sqs(queue)`, or infra maps the queue to the function with `eventSourceMapping()`.

## `queue(config)`

```ts [infra/orders.ts]
import { queue } from "@notation/aws/sqs";
import { Order } from "shared/schema";

export const orderQueue = queue({ name: "orders", schema: Order });
```

### Config

```ts [@notation/aws/sqs]
type QueueConfig = {
  name: string;
  fifo?: boolean;
  schema?: StandardSchemaV1;
  visibilityTimeout?: number;
  messageRetentionPeriod?: number;
  delaySeconds?: number;
  receiveMessageWaitTime?: number;
};
```

`name` keys the queue in state, so changing it replaces the queue. In AWS, the queue is named `<app>--<stage>--<name>`, such as `my-app--prod--orders`. See [AWS names](../manual/project-config.md#aws-names). A FIFO queue's name must end in `.fifo`, and `fifo` can't change after the queue is created.

`schema` is a [Standard Schema](https://standardschema.dev) for the message bodies. AWS doesn't see it. A function that reads the queue with `sqs(queue)` validates each message with it; see [Validating messages](#validating-messages).

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

## `sqs(queue, options)`

A declaration names the queue that its function reads in `event`:

::code-group

```ts [runtime/orders.ts]
import { $lambda, sqs, type LambdaHandler } from "@notation/aws/lambda";
import { orderQueue } from "infra/orders";

export const lambda = $lambda({
  id: "orders",
  event: () => sqs(orderQueue, { batchSize: 5 }),
});

export const handler: LambdaHandler<typeof lambda> = async (event) => {
  for (const record of event.Records) {
    const order = await lambda.decode(record);
    console.log(order.orderId);
  }
};
```

```ts [infra/orders.ts]
import { queue } from "@notation/aws/sqs";
import { Order } from "shared/schema";

export const orderQueue = queue({ name: "orders", schema: Order });
```

::

The infra module only declares the queue. When infra has finished loading, the declaration maps `orderQueue` to the `orders` function, and changes two things:

1. **The role's inline policy.** The declaration contributes a statement that allows `sqs:ReceiveMessage`, `sqs:DeleteMessage` and `sqs:GetQueueAttributes` on the queue to the function's [inline policy](lambda.md#inline-policy).
2. **An event source mapping**, `orders-orders-mapping`, which connects the queue to the function. The mapping belongs to the queue's group.

The mapping depends on the policy, even though it reads nothing from it. This matters because AWS checks the role's permissions when it creates the mapping, so the policy has to exist first. Notation retries the create while the new permissions propagate through IAM.

The mapping doesn't turn on `ReportBatchItemFailures`. So if the handler returns `{ batchItemFailures }`, Lambda ignores it, and a batch either succeeds or fails as a whole.

`sqs()` with no queue declares a function that receives SQS messages from a mapping that infra makes with [`eventSourceMapping()`](#eventsourcemappingconfig).

### Options

```ts [@notation/aws/lambda]
type SqsOptions = {
  batchSize?: number;
  maxBatchingWindow?: number;
};
```

When you remove `batchSize` or `maxBatchingWindow`, Notation sets the mapping back to the Lambda defaults: a batch size of 10 and a batching window of 0 seconds.

### Validating messages

`lambda.decode(record)` parses the record's body as JSON, and validates it with the queue's `schema`. It returns the schema's output type. See [Validating bodies with `decode()`](../manual/functions.md#validating-bodies-with-decode).

The schema must be imported from a shared module, such as `shared/schema.ts` in `files.shared`. **This matters because the function loads the schema, but not the infra module.** In the function's bundle, the runtime build replaces `orderQueue` with an object that holds only the schema:

```ts [runtime/orders.ts, as the runtime build strips it]
import { Order as __notation_schema_0 } from "/path/to/my-app/shared/schema.ts"; // <- added by the build

export const lambda = $lambda({
  id: "orders",
  event: () => sqs({ schema: __notation_schema_0 }, undefined),
});
```

The build imports the schema by its absolute path, from the file that infra imports it from. The `infra/orders` import is gone, and so is `batchSize`, which only infra reads.

A schema that the infra module defines itself fails the build. So does a schema written as `schemas.Order` or `Order.extend({ ... })`: export the value from the shared module, and import it by name. A queue that a helper function makes fails the build too. See [Resource arguments](../internals/compiler.md#resource-arguments).

Nothing checks the messages that a sender writes. To send messages, use `@aws-sdk/client-sqs` in your own code.

## `eventSourceMapping(config)`

`eventSourceMapping()` from `@notation/aws/lambda` maps a queue to a function from infra. It changes the same two things as `sqs(queue)`: the role's inline policy and an event source mapping.

```ts [@notation/aws/lambda]
type EventSourceMappingConfig = SqsOptions & {
  source: QueueGroup;
  target: LambdaTarget<"sqs" | "none">;
};
```

`target` is a declaration, passed as a function such as `() => processOrders`, or a Lambda group from [`lambda()`](lambda.md#lambdaconfig), passed as it is. The declaration must have `event: () => sqs()`, or no `event`. See [Wiring a declaration](lambda.md#wiring-a-declaration).

`eventSourceMapping()` throws for a declaration in two cases:

- **The declaration names a queue itself**, with `sqs(queue)`. Map the queue in one place.
- **The queue has a `schema`, and the declaration has `event: () => sqs()`.** The declaration's `decode()` would not validate messages with the queue's schema. Declare the function with `event: () => sqs(queue)` instead.

A declaration with no `event`, and a Lambda group from `lambda()`, can read a queue with a schema, because neither calls `decode()`.

### Several queues

A declaration's `event` names at most one queue. To feed one function from two queues, declare it with `sqs()`, and map each queue with `eventSourceMapping()`:

::code-group

```ts [infra/orders.ts]
import { eventSourceMapping } from "@notation/aws/lambda";
import { queue } from "@notation/aws/sqs";
import { lambda as processOrders } from "runtime/orders";

export const orderQueue = queue({ name: "orders" });
export const refundQueue = queue({ name: "refunds" });

eventSourceMapping({ source: orderQueue, target: () => processOrders });
eventSourceMapping({ source: refundQueue, target: () => processOrders });
```

```ts [runtime/orders.ts]
import { $lambda, sqs, type LambdaHandler } from "@notation/aws/lambda";
import { refundQueue } from "infra/orders";

export const lambda = $lambda({
  id: "orders",
  event: () => sqs(),
  env: () => ({ REFUND_QUEUE_ARN: refundQueue.arn }),
});

export const handler: LambdaHandler<typeof lambda> = async (event) => {
  for (const record of event.Records) {
    const kind =
      record.eventSourceARN === lambda.env().REFUND_QUEUE_ARN
        ? "refund"
        : "order";
    console.log(kind, record.body);
  }
};
```

::

Each queue contributes its own statement and its own mapping, so the function's policy has two statements. When you delete the second `eventSourceMapping()` call, its statement and mapping go with it, and the next deploy updates the policy and deletes the mapping.

The function's one `handler` receives the messages of both queues. Each record's `eventSourceARN` names its queue, so the handler compares it with the ARN of `refundQueue`, bound in `env`. The queues have no schema, because `eventSourceMapping()` throws for a declaration with `sqs()` and a queue with a schema.

A queue can feed a given function once. A second mapping of the same queue and function throws.

## `queue.grant(actions)`

`grant` returns a policy statement for the queue. A declaration adds it to its function's role with the `policy` option. For example, to let the `orders` function send messages to `refundQueue`, and read the queue's URL:

```ts [runtime/orders.ts]
import { $lambda, sqs } from "@notation/aws/lambda";
import { refundQueue } from "infra/orders";

export const lambda = $lambda({
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
