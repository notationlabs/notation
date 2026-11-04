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

Runtime code that imports `orderQueue` `with { type: "infra" }` sees `orderQueue.url` as a `string`, and the function receives the URL when it deploys. See [Sending to a queue](#sending-to-a-queue).

An output value can only be placed whole. Turning it into a string, for example in a template string, throws. To build a value from the queue's ARN, contribute a function that receives `orderQueue.queue` as a dep; see [Function contributions](../internals/resource.md#function-contributions).

## `queue.consume(handler)`

`consume` invokes a function with the queue's messages:

::code-group

```ts [infra/orders.ts]
import { queue } from "@notation/aws/sqs";
import { processOrders } from "runtime/orders.fn" with { type: "runtime" };

export const orderQueue = queue({ name: "orders" });
orderQueue.consume(processOrders, { batchSize: 5 });
```

```ts [runtime/orders.fn.ts]
import { lambda } from "@notation/aws/lambda" with { type: "infra" };

const { handle } = lambda({ id: "orders", timeout: 5, memory: 64 });

export const processOrders = handle.sqsEvent(async (event) => {
  for (const record of event.Records) console.log(record.body);
});
```

::

`processOrders` is a handler of the `orders` function, so in infra code it is a `LambdaRef` of SQS events. See [Lambda](lambda.md#handlers-in-infra). `consume` also takes a Lambda group, such as one that runs [external code](lambda.md#external-code). `consume` wires the handler once infra has been evaluated, because until then `processOrders` is a stand-in.

`consume` changes three things, and the function's own config doesn't mention the queue:

1. **The role's inline policy.** `consume` contributes a statement that allows `sqs:ReceiveMessage`, `sqs:DeleteMessage` and `sqs:GetQueueAttributes` on the queue to the function's [inline policy](lambda.md#inline-policy).
2. **An event source mapping**, `orders-orders-mapping`, which connects the queue to the function.
3. **The function's dispatch map.** `consume` adds an entry that sends messages from the queue's ARN to `processOrders`. A Lambda group from `lambda()` gets no entry. See [Dispatch](lambda.md#dispatch).

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

Each queue contributes its own statement and its own dispatch entry, so two queues can feed one function. The two queues can call the same handler, or two handlers of one function:

```ts [infra/orders.ts]
import {
  processOrders,
  processRefunds,
} from "runtime/orders.fn" with { type: "runtime" };

orderQueue.consume(processOrders);
refundQueue.consume(processRefunds);
```

The function's policy then has two statements. When you delete the `refundQueue.consume` line, its statement and mapping go with it, and the next deploy updates the policy and deletes the mapping.

A queue can feed a given function once. A second `consume` with the same function throws, even with a different handler of the function, because the dispatch map sends all of a queue's messages to one handler.

## `queue.grant(actions)`

`grant` returns a policy statement that allows `actions` on the queue. Pass it to the `grants` setting of `lambda()` to give a function other access, such as sending messages. See [Sending to a queue](#sending-to-a-queue).

A function that runs external code takes `grants` in the same way:

```ts [infra/orders.ts]
import { lambda } from "@notation/aws/lambda";

const importer = lambda({
  id: "order-importer",
  code: { type: "file", path: "external/importer.mjs" },
  grants: [orderQueue.grant(["SendMessage"])],
});
```

A function from a runtime module takes its grants in its own `lambda()` settings. Infra can't contribute to `processOrders.function.policy`, because `processOrders.function` is a stand-in until infra has been evaluated, and reading its `policy` throws.

The statements go on the function's role, so every handler of the function gets the access.

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

## Sending to a queue

A function that sends messages needs the queue's URL and permission to send. The runtime module imports the queue `with { type: "infra" }`, grants `SendMessage` in the `lambda()` settings, and reads `orderQueue.url` in the handler:

```ts [runtime/checkout.fn.ts]
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { json } from "@notation/aws/lambda.fn";
import { lambda } from "@notation/aws/lambda" with { type: "infra" };
import { orderQueue } from "infra/orders" with { type: "infra" };

const sqs = new SQSClient();

const { handle } = lambda({
  id: "checkout",
  timeout: 5,
  grants: [orderQueue.grant(["SendMessage"])],
});

export const createOrder = handle.apiRequest(async (req) => {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: orderQueue.url,
      MessageBody: req.body ?? "{}",
    }),
  );
  return json({ ok: true });
});
```

The compiler bundles `createOrder` without infra, and the function receives the queue's URL when it deploys. See [Reading Infra Values](../manual/infra-values.md).
