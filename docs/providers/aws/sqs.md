# SQS

`@notation/aws/sqs` creates SQS queues. A Lambda function reads a queue in one of two ways:

| Function-led                                    | Infra-led                                                                       |
| ----------------------------------------------- | ------------------------------------------------------------------------------- |
| `event: () => sqs.bind(orderQueue)`             | `event: () => sqs.schema(Order)`                                                |
| The declaration maps the queue to the function. | Infra maps queues with `eventSourceMapping({ source, target })`.                |
| `decode()` validates with the queue's schema.   | `decode()` validates with `Order`. Each mapped queue must have the same schema. |

`sqs` comes from `@notation/aws/lambda`. It is an object with the two methods `bind()` and `schema()`, and it can't be called itself.

## `queue(config)`

```ts [infra/orders.ts]
import { queue } from "@notation/aws/sqs";
import { Order } from "shared/schema";

export const orderQueue = queue({ id: "orders", schema: Order });
```

### Config

```ts [@notation/aws/sqs]
type QueueConfig = {
  id: string;
  fifo?: boolean;
  schema: StandardSchemaV1;
  visibilityTimeout?: number;
  messageRetentionPeriod?: number;
  delaySeconds?: number;
  receiveMessageWaitTime?: number;
  maximumMessageSize?: number;
  deadLetterQueue?: { queue: QueueGroup | string; maxReceiveCount: number };
  contentBasedDeduplication?: boolean;
  deduplicationScope?: "queue" | "messageGroup";
  fifoThroughputLimit?: "perQueue" | "perMessageGroupId";
};
```

`id` keys the queue in state, so changing it replaces the queue. Use 1 to 64 letters, digits, hyphens and underscores, as a string literal. Deploy generates the queue's AWS name when it first creates the queue, and keeps the name in state. The name is `<app>--<stage>--<id>-<instance>`, such as `my-app--prod--orders-1a2b3c4d`, where the instance is 8 random hex characters.

You can't set the queue's AWS name. See [AWS names](../../manual/project-config.md#aws-names).

`fifo: true` makes a FIFO queue. The AWS name of a FIFO queue ends in `.fifo`, as SQS requires. The generated name ends in it, such as `my-app--prod--ledger-1a2b3c4d.fifo`. `fifo` can't change after the queue is created, so changing it replaces the queue, and the replacement gets a name with the right ending.

There is one case where the ending is wrong. If the create of a queue ends with an unknown outcome, state keeps the generated name for the next deploy. If you turn `fifo` on before that deploy, the name in state has no `.fifo`, and each deploy fails until you turn `fifo` off again. Turn `fifo` on after a deploy has created the queue.

`schema` is a [Standard Schema](https://standardschema.dev) for the message bodies. AWS doesn't see it. A function that reads the queue with `sqs.bind(queue)` validates each message with it; see [Validating messages](#validating-messages). A function declared with `sqs.schema()` that infra maps the queue to must be given the same schema; see [`eventSourceMapping(config)`](#eventsourcemappingconfig).

**Every queue has a schema.** `queue({ id: "orders" })` is a type error, and it throws when infra runs. This matters because it means that no function reads a queue's messages without validating them. A queue that takes any JSON body declares a schema that accepts any value, such as valibot's `v.unknown()`:

```ts [shared/schema.ts]
import * as v from "valibot";

export const AuditEvent = v.unknown();
```

```ts [infra/audit.ts]
import { queue } from "@notation/aws/sqs";
import { AuditEvent } from "shared/schema";

export const auditQueue = queue({ id: "audit", schema: AuditEvent });
```

`decode()` still parses each message body as JSON before it validates it, so a body that isn't JSON throws a `DecodeError` even with `v.unknown()`. `AuditEvent` comes from a shared module for the same reason as `Order`: a function that reads the queue loads the schema. See [Validating messages](#validating-messages).

The other settings can change in place. When you remove one, Notation sets it back to the value SQS gives a new queue, because SQS can't unset a queue attribute:

| Setting                  | SQS attribute                   | Default                 |
| ------------------------ | ------------------------------- | ----------------------- |
| `visibilityTimeout`      | `VisibilityTimeout`             | 30 seconds              |
| `messageRetentionPeriod` | `MessageRetentionPeriod`        | 345,600 s (4 days)      |
| `delaySeconds`           | `DelaySeconds`                  | 0                       |
| `receiveMessageWaitTime` | `ReceiveMessageWaitTimeSeconds` | 0                       |
| `maximumMessageSize`     | `MaximumMessageSize`            | 1,048,576 bytes (1 MiB) |
| `deadLetterQueue`        | `RedrivePolicy`                 | No dead-letter queue    |

A FIFO queue also takes these settings. `queue()` throws when a standard queue sets one of them.

| Setting                     | SQS attribute               | Default      |
| --------------------------- | --------------------------- | ------------ |
| `contentBasedDeduplication` | `ContentBasedDeduplication` | `false`      |
| `deduplicationScope`        | `DeduplicationScope`        | `"queue"`    |
| `fifoThroughputLimit`       | `FifoThroughputLimit`       | `"perQueue"` |

For high throughput, set `deduplicationScope: "messageGroup"` and `fifoThroughputLimit: "perMessageGroupId"`. SQS allows `"perMessageGroupId"` only with `"messageGroup"`, so `queue()` throws when `fifoThroughputLimit` is `"perMessageGroupId"` and `deduplicationScope` is not `"messageGroup"`. With `contentBasedDeduplication: true`, SQS deduplicates messages by a SHA-256 hash of the body, so a sender doesn't have to give a deduplication ID.

SQS encrypts a new queue with keys that SQS owns (SSE-SQS). Notation doesn't set the encryption attributes, so a queue keeps this default.

SQS doesn't let you reuse a deleted queue's name for 60 seconds. The replacement of a queue gets a new name, so it doesn't wait. A queue that was deleted outside Notation is different: deploy creates it again under the name in state. If the queue was deleted less than 60 seconds before, deploy waits and retries the create until SQS accepts the name.

### Dead-letter queues

`deadLetterQueue` names a second queue. SQS moves a message to it after the message has been received `maxReceiveCount` times without being deleted. A message is received again when the handler throws, when the function times out, or when the handler reports the message as failed with `reportBatchItemFailures`. See [Failed messages](#failed-messages).

```ts [shared/schema.ts]
import * as v from "valibot";

export const DeadLetter = v.unknown();
```

```ts [infra/orders.ts]
import { queue } from "@notation/aws/sqs";
import { DeadLetter, Order } from "shared/schema";

export const orderDeadLetterQueue = queue({
  id: "orders-dlq",
  schema: DeadLetter,
});

export const orderQueue = queue({
  id: "orders",
  schema: Order,
  deadLetterQueue: { queue: orderDeadLetterQueue, maxReceiveCount: 3 },
});
```

`maxReceiveCount` is from 1 to 1,000. The dead-letter queue is a queue like any other, so it has a schema. SQS moves the messages unchanged, so give it a schema that accepts the messages of each queue that uses it. Notation doesn't compare the schemas. A message often reaches the dead-letter queue because it failed validation, so `DeadLetter` above accepts any value.

`queue` is a queue from `queue()`, or the ARN of a queue that Notation doesn't manage:

```ts [infra/orders.ts]
export const orderQueue = queue({
  id: "orders",
  schema: Order,
  deadLetterQueue: {
    queue: "arn:aws:sqs:eu-west-2:123456789012:shared-dlq",
    maxReceiveCount: 3,
  },
});
```

Notation doesn't check the ARN or that the queue exists. SQS rejects a bad ARN at deploy. SQS requires the dead-letter queue to be in the same account and region as the queue.

The queue's `RedrivePolicy` holds the ARN of the dead-letter queue. When the dead-letter queue comes from `queue()`, the queue depends on the dead-letter queue, which deploys first. When you remove `deadLetterQueue`, Notation removes the policy from the queue, and leaves the dead-letter queue and its messages.

A FIFO queue needs a FIFO dead-letter queue, and a standard queue needs a standard one. `queue()` throws when the two queues are of different types. For an ARN, `queue()` reads the type from the end of the ARN, because SQS requires the name of a FIFO queue to end in `.fifo`. When `queue` is the `arn` output ref of a queue from `queue()`, the ARN is not known until deploy, so `queue()` doesn't check the type, and SQS rejects a mismatch at deploy.

For a standard queue, a moved message keeps the time it was first sent, and the dead-letter queue's `messageRetentionPeriod` counts from that time. So give the dead-letter queue a longer `messageRetentionPeriod` than the queue.

To read the dead-letter queue, map it to a function as you would any other queue.

### `arn` and `url`

`orderQueue.arn` and `orderQueue.url` are output refs: they don't exist until AWS creates the queue, but you can place them in another resource's config now. Notation makes that resource depend on the queue and fills in the real value at deploy. See [Output refs](../../reference/resource.md#output-refs).

An output ref can only be placed whole. Turning it into a string, for example in a template string, throws. To build a value from the queue's ARN, contribute a function that receives `orderQueue.queue` as a dep; see [Function contributions](../../reference/resource.md#function-contributions).

## `sqs.bind(queue, options)`

A declaration names the queue that its function reads in `event`:

::code-group

```ts [runtime/orders.ts]
import { $lambda, sqs, type LambdaHandler } from "@notation/aws/lambda";
import { orderQueue } from "infra/orders";

export const lambda = $lambda({
  id: "orders",
  event: () => sqs.bind(orderQueue, { batchSize: 5 }),
});

export const handler: LambdaHandler<typeof lambda> = async (event) => {
  for (const record of event.Records) {
    const { body: order } = await lambda.decode(record);
    console.log(order.orderId);
  }
};
```

```ts [infra/orders.ts]
import { queue } from "@notation/aws/sqs";
import { Order } from "shared/schema";

export const orderQueue = queue({ id: "orders", schema: Order });
```

::

The infra module only declares the queue. When infra has finished loading, the declaration maps `orderQueue` to the `orders` function, and changes two things:

1. **The role's inline policy.** The declaration contributes a statement that allows `sqs:ReceiveMessage`, `sqs:DeleteMessage` and `sqs:GetQueueAttributes` on the queue to the function's [inline policy](lambda.md#inline-policy).
2. **An event source mapping**, `orders-orders-mapping`, which connects the queue to the function. The mapping belongs to the queue's group.

The mapping depends on the policy, even though it reads nothing from it. This matters because AWS checks the role's permissions when it creates the mapping, so the policy has to exist first. Notation retries the create while the new permissions propagate through IAM.

### Options

```ts [@notation/aws/lambda]
type SqsOptions = {
  batchSize?: number;
  maximumBatchingWindow?: number;
  reportBatchItemFailures?: boolean;
  maximumConcurrency?: number;
  enabled?: boolean;
};
```

| Option                    | Mapping field                    | Default when removed |
| ------------------------- | -------------------------------- | -------------------- |
| `batchSize`               | `BatchSize`                      | 10                   |
| `maximumBatchingWindow`   | `MaximumBatchingWindowInSeconds` | 0 seconds            |
| `reportBatchItemFailures` | `FunctionResponseTypes`          | Off                  |
| `maximumConcurrency`      | `ScalingConfig`                  | No limit             |
| `enabled`                 | `Enabled`                        | `true`               |

When you remove an option, Notation sets the mapping back to the Lambda default.

A `batchSize` over 10 needs a `maximumBatchingWindow` of at least 1 second. A FIFO queue allows a `batchSize` of at most 10, and no `maximumBatchingWindow`. Lambda would reject these at deploy, so the mapping throws when infra loads.

`maximumConcurrency` is the most instances of the function that the mapping invokes at once, from 2 to 1,000. It limits this mapping only. The function's reserved concurrency limits the function as a whole.

`enabled: false` pauses the mapping. Lambda stops reading the queue, and the messages stay in it.

### Failed messages

By default, a batch succeeds or fails as a whole. If the handler throws, every message in the batch returns to the queue, and Lambda receives them again after the visibility timeout. This includes the messages that the handler processed.

With `reportBatchItemFailures: true`, the handler returns the IDs of the messages that failed. Lambda deletes the other messages, and only the failed ones return to the queue:

```ts [runtime/orders.ts]
import { $lambda, sqs, type LambdaHandler } from "@notation/aws/lambda";
import { orderQueue } from "infra/orders";

export const lambda = $lambda({
  id: "orders",
  event: () => sqs.bind(orderQueue, { reportBatchItemFailures: true }),
});

export const handler: LambdaHandler<typeof lambda> = async (event) => {
  const batchItemFailures: { itemIdentifier: string }[] = [];
  for (const record of event.Records) {
    try {
      const { body: order } = await lambda.decode(record);
      console.log(order.orderId);
    } catch {
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures };
};
```

Without the option, Lambda ignores the result and deletes every message in the batch, including the failed ones. So for a declaration with `sqs.bind()`, `LambdaHandler` lets the handler return `{ batchItemFailures }` only when `reportBatchItemFailures` is `true`. For a declaration with `sqs.schema()`, infra makes the mapping, so `LambdaHandler` allows either result, and you must set the option on `eventSourceMapping()`. A message that keeps failing returns to the queue until it expires, or until SQS moves it to the [dead-letter queue](#dead-letter-queues).

The loop above continues after a failed message, which suits a standard queue. A handler of a FIFO queue must stop at the first failed message, and report it and every message after it in the batch. Otherwise Lambda deletes the later messages of the group before the failed one is processed, and the group's order is lost.

### Validating messages

`lambda.decode(record)` parses the record's body as JSON, and validates it with the queue's `schema`. It returns the record with `body` in place of the JSON string, so `body` has the schema's output type. See [Validating bodies with `decode()`](../../manual/functions.md#validating-bodies-with-decode).

Import the schema from a shared module, such as `shared/schema.ts` in `files.shared`, or from a package. A file with no kind also works, if it calls no resource function at its top level. **This matters because the function loads the schema, but not the infra module.** In the function's bundle, the runtime build replaces `orderQueue` with an object that holds only the schema:

```ts [runtime/orders.ts, as the runtime build strips it]
import { Order as __notation_schema_0 } from "/path/to/my-app/shared/schema.ts"; // <- added by the build

export const lambda = $lambda({
  id: "orders",
  event: () => sqs.bind({ schema: __notation_schema_0 }, { batchSize: 5 }),
});
```

The build imports the schema by its absolute path, from the file that infra imports it from. The `infra/orders` import is gone. The options, such as `batchSize`, stay as they are. The function doesn't read them, but they must be values that the function can load: literals, or values from a shared module.

A schema that the infra module defines itself fails the build. So does a schema written as `schemas.Order` or `Order.extend({ ... })`: export the value from the shared module, and import it by name. A queue that a helper function makes fails the build too: declare it with a call to `queue()`.

Nothing checks the messages that a sender writes. To send messages, use `@aws-sdk/client-sqs` in your own code.

## `sqs.schema(schema)`

A declaration that infra maps queues to names the schema of their messages, and no queue:

```ts [runtime/orders.ts]
import { $lambda, sqs, type LambdaHandler } from "@notation/aws/lambda";
import { Order } from "shared/schema";

export const lambda = $lambda({
  id: "orders",
  event: () => sqs.schema(Order),
});

export const handler: LambdaHandler<typeof lambda> = async (event) => {
  for (const record of event.Records) {
    const { body: order } = await lambda.decode(record);
    console.log(order.orderId);
  }
};
```

`lambda.decode(record)` validates the record's body with `Order`, as it does with the queue's schema for `sqs.bind()`. The declaration doesn't import infra, so the runtime build leaves `sqs.schema(Order)` as it is. `Order` must come from a shared module or a package, because the function loads it.

## `eventSourceMapping(config)`

`eventSourceMapping()` from `@notation/aws/lambda` maps a queue to a function from infra. It changes the same two things as `sqs.bind(queue)`: the role's inline policy and an event source mapping.

```ts [infra/orders.ts]
import { eventSourceMapping } from "@notation/aws/lambda";
import { queue } from "@notation/aws/sqs";
import { lambda as processOrders } from "runtime/orders";
import { Order } from "shared/schema";

export const orderQueue = queue({ id: "orders", schema: Order });

eventSourceMapping({ source: orderQueue, target: () => processOrders });
```

`runtime/orders.ts` is the declaration with `sqs.schema(Order)` above. The queue and the declaration import the same `Order` from `shared/schema.ts`, so the schema is checked at both ends: infra checks that the two schemas are the same object, and the function validates each message with it.

```ts [@notation/aws/lambda]
type EventSourceMappingConfig<S> = SqsOptions & {
  source: SqsSource<S>;
  target: SqsTarget<S>;
};
```

`source` is a queue from `queue()`. `SqsSource` is the part of a queue that `sqs.bind()` and `eventSourceMapping()` use: its `schema`, and a method that maps it to a function.

`target` is a declaration, passed as a function such as `() => processOrders`, or a Lambda group from [`lambda()`](lambda.md#lambdaconfig), passed as it is. See [Wiring a declaration](lambda.md#wiring-a-declaration). The target can be:

| Target                                 | Result                                  |
| -------------------------------------- | --------------------------------------- |
| A declaration with `sqs.schema(Order)` | Mapped if the queue's schema is `Order` |
| A declaration with no `event`          | Mapped                                  |
| A Lambda group from `lambda()`         | Mapped                                  |
| A declaration with `sqs.bind(queue)`   | Throws                                  |

**The schema check compares objects, not types.** `eventSourceMapping()` throws when the queue's `schema` is another object than the one in `sqs.schema()`, even if the two schemas accept the same messages. TypeScript also checks the pairing: `SqsTarget<S>` only takes a declaration whose schema has the type of the queue's schema, so a declaration with `sqs.schema(Refund)` and a queue with `schema: Order` is a type error.

A declaration with `sqs.bind(queue)` already maps a queue, so `eventSourceMapping()` throws for it. Map the queue in one place: remove the `eventSourceMapping()` call, or declare the function with `sqs.schema()`.

### Several queues

`sqs.bind()` names one queue. To feed one function from two queues, declare it with `sqs.schema()`, and map each queue with `eventSourceMapping()`:

::code-group

```ts [infra/orders.ts]
import { eventSourceMapping } from "@notation/aws/lambda";
import { queue } from "@notation/aws/sqs";
import { lambda as processOrders } from "runtime/orders";
import { Order } from "shared/schema";

export const orderQueue = queue({ id: "orders", schema: Order });
export const priorityQueue = queue({ id: "priority-orders", schema: Order });

eventSourceMapping({ source: orderQueue, target: () => processOrders });
eventSourceMapping({ source: priorityQueue, target: () => processOrders });
```

```ts [runtime/orders.ts]
import { $lambda, sqs, type LambdaHandler } from "@notation/aws/lambda";
import { priorityQueue } from "infra/orders";
import { Order } from "shared/schema";

export const lambda = $lambda({
  id: "orders",
  event: () => sqs.schema(Order),
  env: () => ({ PRIORITY_QUEUE_ARN: priorityQueue.arn }),
});

export const handler: LambdaHandler<typeof lambda> = async (event) => {
  for (const record of event.Records) {
    const { body: order, eventSourceARN } = await lambda.decode(record);
    const priority = eventSourceARN === lambda.env().PRIORITY_QUEUE_ARN;
    console.log(order.orderId, priority);
  }
};
```

::

Each queue contributes its own statement and its own mapping, so the function's policy has two statements. When you delete the second `eventSourceMapping()` call, its statement and mapping go with it, and the next deploy updates the policy and deletes the mapping.

The function's one `handler` receives the messages of both queues. Each record's `eventSourceARN` names its queue, so the handler compares it with the ARN of `priorityQueue`, bound in `env`.

A queue can feed a given function once. A second mapping of the same queue and function throws.

The resource class `LambdaEventSourceMapping` supports one mapping per function and event source. Lambda keeps a queue's mapping to a function unique. It allows several mappings of one stream to one function, and Notation fails when it looks such a mapping up and finds more than one.

## `queue.grant(actions)`

`grant` returns a policy statement for the queue. A declaration adds it to its function's role with the `policy` option. For example, to let the `orders` function send messages to `refundQueue`, and read the queue's URL:

```ts [runtime/orders.ts]
import { $lambda, sqs } from "@notation/aws/lambda";
import { refundQueue } from "infra/orders";
import { Order } from "shared/schema";

export const lambda = $lambda({
  id: "orders",
  event: () => sqs.schema(Order),
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
