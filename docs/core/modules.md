# Modules

Notation splits a TypeScript project into **infra**, **runtime**, and **shared** modules so deployment SDKs never ship inside function bundles. You write imports naturally across folders while the compiler builds a Node deployment graph and isolated per-function bundles.

This AWS example pairs a shared schema, an SQS queue, and a `$lambda` consumer across the three default directories:

::code-group

```ts [runtime/orders.ts]
import { $lambda, sqs, type LambdaHandler } from "@notation/aws/lambda";
import { orderQueue } from "../infra/orders";

export const lambda = $lambda({
  id: "orders",
  event: () => sqs.bind(orderQueue, { batchSize: 5 }),
  env: () => ({ ORDER_QUEUE_URL: orderQueue.url }),
});

export const handler: LambdaHandler<typeof lambda> = async (event) => {
  for (const record of event.Records) {
    const { body: order } = await lambda.decode(record);
    console.log("order", order.orderId, lambda.env().ORDER_QUEUE_URL);
  }
};
```

```ts [infra/orders.ts]
import { queue } from "@notation/aws/sqs";
import { Order } from "../shared/schema";

export const orderQueue = queue({
  id: "orders",
  schema: Order,
});
```

```ts [shared/schema.ts]
import * as v from "valibot";

export const Order = v.object({
  orderId: v.string(),
  quantity: v.pipe(v.number(), v.integer(), v.minValue(1)),
});
```

::

Customize the folder paths for each role with `files` in [Project Config](./project-config.md).

## Module roles

Notation assigns each file one of three build roles from its directory so deploy-time SDKs and runtime handlers compile separately:

| Directory | Purpose |
| :--- | :--- |
| `infra/**` | Declares resources, routes, and permissions in Node from `entry` without entering function bundles |
| `runtime/**` | Colocates a compute [declaration](./declarations.md) with its handler for dual infrastructure and runtime builds |
| `shared/**` | Holds schemas, types, and pure helpers compiled unmodified into both builds |

Each `runtime/` module may export at most one declaration (`$lambda`, `$worker`, or `$durableObject`). During the infrastructure build, Notation strips handler code; during the runtime build, it bundles the handler and replaces imported `infra/` resources with lightweight metadata.

## Crossing boundaries

Static boundary checks keep deploy-time code out of production functions while allowing typed wiring across folders:

- **Infra importing runtime** – Import declarations from `runtime/` only to pass into lazy wiring thunks such as `() => createOrder`; move reusable helpers into `shared/`.
- **Runtime importing infra** – Pass `infra/` resources directly into declaration options (`event`, `env`, `bindings`) without aliasing them locally or referencing them inside handler logic.
- **Shared staying pure** – Keep `shared/` free of declarations, resource builders, and value imports from `infra/` or `runtime/`.

Type-only imports and exports (`import type`, `export type`) are allowed across any boundary.

## Passing deploy values

Handlers cannot read cloud resource properties directly at runtime because those objects only exist during deployment. Instead, project queue URLs, secrets, or Worker bindings through `env()` on AWS `$lambda` or `bindings()` on Cloudflare `$worker`:

::code-group

```ts [runtime/orders.ts (AWS)]
import { $lambda, sqs, type LambdaHandler } from "@notation/aws/lambda";
import { orderQueue } from "../infra/orders";

export const lambda = $lambda({
  id: "orders",
  event: () => sqs.bind(orderQueue),
  env: () => ({ ORDER_QUEUE_URL: orderQueue.url }),
});

export const handler: LambdaHandler<typeof lambda> = async (event) => {
  const { body: order } = await lambda.decode(event.Records[0]!);
  const { ORDER_QUEUE_URL } = lambda.env();
  console.log(order.orderId, ORDER_QUEUE_URL);
};
```

```ts [runtime/api.ts (Cloudflare)]
import { $worker, json, type WorkerHandler } from "@notation/cloudflare/workers";
import { ordersCache } from "../infra/storage";

export const worker = $worker({
  id: "api",
  compatibilityDate: "2026-10-12",
  bindings: () => ({
    ORDERS_CACHE: ordersCache,
    CONFIG: json({ maxRetries: 3 }),
  }),
});

export default {
  async fetch(request, env) {
    const orderId = new URL(request.url).searchParams.get("orderId") ?? "latest";
    const cached = await env.ORDERS_CACHE.get(orderId);
    return Response.json({ cached, maxRetries: env.CONFIG.maxRetries });
  },
} satisfies WorkerHandler<typeof worker>;
```

::

At runtime, `lambda.env()` reads values from `process.env` and throws outside the runtime build unless unit tests pass `--conditions=notation-runtime`. On Cloudflare, `$worker` injects `bindings()` onto `env` and forwards non-credential outputs or derived strings as plain text while rejecting `StateRef`.

## Platform constraints

Notation targets `node` for AWS Lambda and `workerd` for Cloudflare Workers:

- **Isolate `cloudflare:` imports** – Keep `cloudflare:*` imports inside Worker handlers and entrypoints rather than `infra/` modules or deploy options.
- **Keep Worker exports clean** – `workerd` rejects Worker modules exporting primitive constants or namespace re-exports; move shared constants to `shared/` or bind them with `bindings()`.
