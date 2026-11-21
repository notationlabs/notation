# Introduction

Notation Deploy is a TypeScript framework for defining and deploying cloud infrastructure and serverless functions in one codebase. Resource schemas, environment variables, bindings, and secrets flow from your infrastructure definitions straight into your runtime code.

## Application structure

A Notation project separates files into **runtime** modules for colocated compute, **infra** modules for supporting cloud resources, and **shared** modules for schemas and pure helpers.

### Example: AWS API Gateway

With `@notation/aws`, you declare a Lambda function and its request schema next to the handler, then mount it onto an HTTP API:

::code-group

```ts [runtime/create-order.ts]
import { $lambda, apiGateway, type LambdaHandler } from "@notation/aws/lambda";
import { CreateOrder } from "../shared/schemas";

export const createOrder = $lambda({
  id: "create-order",
  timeout: 10,
  event: () => apiGateway.schema(CreateOrder),
});

export const handler: LambdaHandler<typeof createOrder> = async (event) => {
  const { body } = await createOrder.decode(event);
  return { statusCode: 201, body: JSON.stringify(body) };
};
```

```ts [infra/api.ts]
import { api, router } from "@notation/aws/api-gateway";
import { createOrder } from "../runtime/create-order";

const ordersApi = api({ id: "orders-api" });
router(ordersApi).post("/orders", () => createOrder);
```

```ts [shared/schemas.ts]
import * as v from "valibot";

export const CreateOrder = v.object({
  orderId: v.string(),
  quantity: v.pipe(v.number(), v.integer(), v.minValue(1)),
});
```

```ts [notation.config.ts]
import { defineConfig } from "@notation/core/config";

export default defineConfig({
  app: "orders-app",
  entry: "infra/api.ts",
  defaultStage: "dev",
});
```

::

Because both sides reference `CreateOrder`, `router().post()` verifies at compile time that `createOrder` expects an API Gateway event, while `createOrder.decode(event)` validates incoming JSON at runtime.

### Example: Cloudflare Worker

With `@notation/cloudflare`, `$worker` declares bindings next to the Worker handler and propagates their runtime types straight into `env`:

::code-group

```ts [runtime/orders-worker.ts]
import { $worker, type WorkerHandler } from "@notation/cloudflare/workers";
import { orderCache } from "../infra/storage";

export const ordersWorker = $worker({
  id: "orders-worker",
  compatibilityDate: "2026-10-12",
  bindings: () => ({ CACHE: orderCache }),
});

export default {
  async fetch(request, env) {
    const orderId = new URL(request.url).searchParams.get("id") ?? "ord_1";
    await env.CACHE.put(orderId, "recorded");
    return Response.json({ ok: true, orderId });
  },
} satisfies WorkerHandler<typeof ordersWorker>;
```

```ts [infra/storage.ts]
import { kv } from "@notation/cloudflare/resources";

export const orderCache = new kv.KVNamespace("order-cache", {
  config: { Title: "orders-cache" },
});
```

::

`WorkerHandler<typeof ordersWorker>` types `env.CACHE` as a `KVNamespace`, and `ordersWorker.url` exposes a typed URL reference you can wire into other resources.

## Dual compilation

Running `notation compile`, `plan`, `deploy`, or `watch` executes two passes so deploy-time SDKs never leak into function bundles:

- **Infrastructure build** – Evaluates `entry` and runtime declarations in Node while stripping handler bodies.
- **Runtime build** – Bundles each function entry for its target platform and replaces imported infrastructure with runtime metadata.

## Safe deployments

`notation plan` compares your resource graph against local state and live cloud APIs to surface drift before making changes. `notation deploy` applies creates, updates, replacements, and deletions in dependency order while holding an exclusive per-stage lock in `.notation/workflows.db`.

If a network failure or crash interrupts a run, pass `--execution-id <id>` to resume from the last checkpoint instead of starting over.

## Supported providers

Notation ships dedicated packages so your project installs only the cloud providers and secret sources you deploy:

| Package | Scope |
| :--- | :--- |
| `@notation/aws` | Lambda, API Gateway, SQS, and EventBridge |
| `@notation/cloudflare` | Workers, Durable Objects, Containers, KV, R2, and Secrets |
| `@notation/std` | Environment variable and `.env` credential sources |
| `@notation/infisical` | Infisical vault credential sources |
