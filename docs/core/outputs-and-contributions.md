# Resource Wiring

Cloud endpoints, queue URLs, and ARNs only exist after deployment, while multiple modules often need to contribute permissions or environment variables to one shared resource. Notation wires deploy-time values across resources using typed references, derived expressions, and collected contributions.

## Wiring outputs

High-level provider groups expose typed outputs such as `orderQueue.url` and `orderQueue.arn`, while low-level resources expose `resource.outputRef(key)`. Passing an output reference into another resource's configuration or a declaration's `env()` or `bindings()` orders the producer first and substitutes the real value during [`notation deploy`](../cli/deploy.md).

Wire a dead-letter queue ARN between two SQS queues and pass the queue URL into a Lambda handler:

::code-group

```ts [infra/orders.ts]
import * as v from "valibot";
import { queue } from "@notation/aws/sqs";

const Order = v.object({ orderId: v.string() });

export const orderDeadLetterQueue = queue({
  id: "orders-dlq",
  schema: Order,
});

export const orderQueue = queue({
  id: "orders",
  schema: Order,
  deadLetterQueue: { queue: orderDeadLetterQueue, maxReceiveCount: 3 },
});
```

```ts [runtime/create-order.ts]
import { $lambda, apiGateway, type LambdaHandler } from "@notation/aws/lambda";
import { orderQueue } from "../infra/orders";

export const createOrder = $lambda({
  id: "create-order",
  event: () => apiGateway.schema(orderQueue.schema),
  env: () => ({ ORDER_QUEUE_URL: orderQueue.url }),
  policy: () => [orderQueue.grant(["SendMessage"])],
});

export const handler: LambdaHandler<typeof createOrder> = async () => {
  const { ORDER_QUEUE_URL } = createOrder.env();
  return { statusCode: 202, body: JSON.stringify({ queueUrl: ORDER_QUEUE_URL }) };
};
```

::

Always pass an `OutputRef` whole rather than converting it with template literals, `String(ref)`, or `JSON.stringify(ref)`, which throws `OutputRefStringError`. Before upstream resources exist, [`notation plan`](../cli/plan.md) displays unresolved references as `{ "$unknown": "after-apply" }`.

For credentials, always use `resource.credentials.<name>` rather than `outputRef()` so secret values stay out of state (see [Secrets](./secrets.md)).

## Derived values

When you need to format a URL or combine multiple deploy-time outputs into a new string or object, use `text`, `.map()`, or `all()` from `@notation/resource`:

```ts [infra/callbacks.ts]
import { all, text } from "@notation/resource";
import { ordersApi, orderQueue } from "./orders";

export const callbackUrl = text`${ordersApi.api.outputRef("ApiEndpoint")}/orders`;

export const queueSummary = all([orderQueue.url, orderQueue.arn]).map(
  ([url, arn]) => `${url}|${arn}`,
);
```

During planning, derived expressions evaluate immediately when upstream outputs are already in state and show `{ "$unknown": "after-apply" }` otherwise. Neither credentials nor state snapshot refs work inside `text`, `.map()`, or `all()`.

## State snapshots

Sometimes a resource needs an identifier from a resource that already depends on it, where a normal output reference would create a dependency cycle.

Call `resource["~state"].outputRef(key)` inside `contribute()` to read that key from the pre-deploy state snapshot without adding a dependency edge:

```ts [infra/audit.ts]
import * as v from "valibot";
import { kvJson } from "@notation/cloudflare/kv";
import { kv } from "@notation/cloudflare/resources";
import { orderQueue } from "./orders";

const QueueAudit = v.object({
  previousQueueName: v.optional(v.string()),
});

export const auditKv = new kv.KVNamespace("audit-kv", {
  config: { Title: "audit" },
});

export const queueAudit = kvJson({
  id: "queue-audit",
  namespace: auditKv,
  key: "queue-audit",
  schema: QueueAudit,
});

// Reads QueueName from state at deploy start without adding a dependency edge.
queueAudit.contribute({
  previousQueueName: orderQueue.queue["~state"].outputRef("QueueName"),
});
```

`StateRef` values resolve to `undefined` before the target exists in state and are restricted to replaceable or key parameters inside `contribute()`.

## Shared contributions

Resource schemas can mark parameters as collectible so unrelated modules can contribute IAM statements, environment variables, or config keys to one shared resource.

Attach policy statements and derived environment variables to an AWS Lambda function from separate modules:

```ts [infra/orders-lambda.ts]
import { text } from "@notation/resource";
import { api } from "@notation/aws/api-gateway";
import { lambda } from "@notation/aws/lambda";
import { orderQueue } from "./orders";

export const ordersApi = api({ id: "orders-api" });

export const createOrder = lambda({
  id: "create-order",
  code: { type: "file", path: "dist/create-order.mjs" },
});

createOrder.policy.contribute({
  PolicyDocument: {
    Statement: [orderQueue.grant(["SendMessage"])],
  },
});

createOrder.fn.contribute({
  Environment: {
    Variables: {
      ORDERS_ENDPOINT: text`${ordersApi.api.outputRef("ApiEndpoint")}/orders`,
    },
  },
});
```

Notation merges contributed map keys deterministically regardless of module import order, and throws `ContributionConflictError` (naming both call sites) if two contributions assign different values to the same path:

```ts [infra/webhooks.ts]
// Throws ContributionConflictError on Environment.Variables.WEBHOOK_MODE:
createOrder.fn.contribute({
  Environment: { Variables: { WEBHOOK_MODE: "sync" } },
});

createOrder.fn.contribute({
  Environment: { Variables: { WEBHOOK_MODE: "async" } },
});
```

> [!NOTE]
> The callback form `contribute(compute, { deps })` is `@deprecated`. Pass `OutputRef` values directly to `contribute(values)` or derive values with `text`, `.map()`, and `all()`.

Call `contribute()` and `dependOn()` only while infrastructure modules load. Optional, non-replacing contributions on resources that support updates can also break circular dependencies automatically during [Reconciliation](./reconciliation.md).
