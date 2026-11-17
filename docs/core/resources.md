# Resources

Every cloud resource in Notation has a stable logical `id` and a `Resource` record in state. Declare resources with logical IDs, organize related resources into groups, and express dependencies cleanly across modules.

## Logical identity

Each resource has a `type` (such as `aws/sqs/Queue`) and a unique `id`. State keys every record by `id`, so renaming a TypeScript variable or moving a declaration between files never triggers replacement.

Declare resources with stable logical IDs instead of encoding stage names manually:

::code-group

```ts [infra/orders.ts (AWS)]
import * as v from "valibot";
import { api } from "@notation/aws/api-gateway";
import { queue } from "@notation/aws/sqs";

const Order = v.object({
  orderId: v.string(),
  quantity: v.pipe(v.number(), v.integer(), v.minValue(1)),
});

export const ordersApi = api({ id: "orders-api" });

export const orderQueue = queue({
  id: "orders",
  schema: Order,
});
```

```ts [infra/orders.ts (Cloudflare)]
import * as v from "valibot";
import { kvJson } from "@notation/cloudflare/kv";
import { kv } from "@notation/cloudflare/resources";

const OrderSettings = v.object({
  maxRetries: v.number(),
});

export const settingsNamespace = new kv.KVNamespace("orders-kv", {
  config: { Title: "orders-settings" },
});

export const orderSettings = kvJson({
  id: "orders-settings",
  namespace: settingsNamespace,
  key: "settings",
  schema: OrderSettings,
});
```

::

Changing an existing resource's `id` creates a new resource and schedules the old `id` for deletion as an orphan. Reusing an `id` with a different resource type or declaring duplicate IDs fails validation before deployment.

## Resource groups

High-level provider helpers bundle multiple cloud resources behind a single `ResourceGroup` while still tracking every member individually in state. For example, an AWS `lambda()` group coordinates the function, execution role, inline policy, code asset, and log group together.

Access member resources on a group to contribute configuration or permissions, while [`notation viz`](../cli/viz.md) renders the group as a nested subgraph:

::code-group

```ts [infra/orders.ts (AWS)]
import * as v from "valibot";
import { lambda } from "@notation/aws/lambda";
import { queue } from "@notation/aws/sqs";

const Order = v.object({ orderId: v.string() });

export const orderQueue = queue({ id: "orders", schema: Order });

export const orderProcessor = lambda({
  id: "process-order",
  code: { type: "file", path: "external/processor.mjs" },
});

// Lazily creates and attaches the inline IAM role policy member.
orderProcessor.policy.contribute({
  PolicyDocument: {
    Statement: [orderQueue.grant(["SendMessage"])],
  },
});
```

```ts [infra/orders.ts (Cloudflare)]
import * as v from "valibot";
import { kvJson } from "@notation/cloudflare/kv";
import { kv } from "@notation/cloudflare/resources";

const OrderConfig = v.object({
  webhooks: v.record(v.string(), v.string()),
});

export const configKv = new kv.KVNamespace("orders-kv", {
  config: { Title: "orders-config" },
});

export const orderConfig = kvJson({
  id: "orders-config",
  namespace: configKv,
  key: "config",
  schema: OrderConfig,
});

// Forwards contributions to the underlying KV value resource.
orderConfig.contribute({
  webhooks: { created: "https://example.com/hooks/orders" },
});
```

::

A resource or nested group can belong to at most one parent group, and shared companion members (such as an inline policy) initialize only when referenced.

## Dependencies

Notation computes deployment order automatically from references in your declarations, plus any explicit ordering edges you add:

- **Output and credential references** – Any output ref (`orderQueue.url`), derived value (`text`, `.map()`, `all()`), or credential ref (`source.credentials.value`) adds a dependency edge from consumer to producer.
- **Explicit ordering** – Constructor `dependencies` or `resource.dependOn(other)` add an ordering edge when no value flows between two resources.

Combine output references, `text`, and `dependOn()` to express both data flow and ordering constraints:

```ts [infra/orders.ts]
import * as v from "valibot";
import { api } from "@notation/aws/api-gateway";
import { lambda } from "@notation/aws/lambda";
import { queue } from "@notation/aws/sqs";
import { text } from "@notation/resource";

const Order = v.object({ orderId: v.string() });

export const ordersApi = api({ id: "orders-api" });
export const orderQueue = queue({ id: "orders", schema: Order });

export const orderProcessor = lambda({
  id: "process-order",
  code: { type: "file", path: "external/processor.mjs" },
});

orderProcessor.fn.contribute({
  Environment: {
    Variables: {
      ORDERS_ENDPOINT: text`${ordersApi.api.outputRef("ApiEndpoint")}/orders`,
      ORDER_QUEUE_URL: orderQueue.url,
    },
  },
});

// Ensures the queue exists before the function deploys even without a direct ref.
orderProcessor.fn.dependOn(orderQueue.queue);
```

Dependencies deploy before dependents, and orphans or stage teardowns delete in reverse dependency order. Self-references to a resource's own generated name and [state snapshot refs](./outputs-and-contributions.md) add no dependency edge.
