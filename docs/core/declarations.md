# Declarations

A declaration colocates a function's cloud configuration, permissions or bindings, and event schema next to its handler. From that single file, Notation builds both the infrastructure resource and an isolated runtime bundle.

## Colocated compute

Place `$lambda` (AWS), `$worker` (Cloudflare), or `$durableObject` (Cloudflare) in `runtime/` (`files.runtime`) right above the handler or entrypoint class it deploys.

### AWS Lambda

Declare `$lambda` in `runtime/` and attach it to an HTTP route from `infra/` with a lazy thunk `() => createOrder`:

::code-group

```ts [runtime/create-order.ts]
import { $lambda, apiGateway, type LambdaHandler } from "@notation/aws/lambda";
import { CreateOrder } from "../shared/schema";

export const createOrder = $lambda({
  id: "create-order",
  timeout: 10,
  event: () => apiGateway.schema(CreateOrder),
  env: () => ({ ORDER_PREFIX: "ord" }),
});

export const handler: LambdaHandler<typeof createOrder> = async (event) => {
  const { body: order } = await createOrder.decode(event);
  const { ORDER_PREFIX } = createOrder.env();
  return {
    statusCode: 201,
    body: JSON.stringify({ id: `${ORDER_PREFIX}-${order.orderId}` }),
  };
};
```

```ts [infra/api.ts]
import { api, router } from "@notation/aws/api-gateway";
import { createOrder } from "../runtime/create-order";

export const ordersApi = api({ id: "orders-api" });
router(ordersApi).post("/orders", () => createOrder);
```

::

Passing `() => createOrder` instead of `createOrder` directly prevents circular initialization when runtime modules import infra resources while infra modules import the declaration.

### Cloudflare Worker

Declare `$worker` next to its default handler to inject storage namespaces, secrets, or plain values onto `env`:

```ts [runtime/api.ts]
import { $worker, type WorkerHandler } from "@notation/cloudflare/workers";
import { orderCache } from "../infra/storage";

export const api = $worker({
  id: "api",
  compatibilityDate: "2026-10-12",
  bindings: () => ({ CACHE: orderCache, ENVIRONMENT: "production" }),
});

export default {
  async fetch(request, env) {
    const id = new URL(request.url).searchParams.get("id") ?? "latest";
    const value = await env.CACHE.get(id);
    return Response.json({ id, value, environment: env.ENVIRONMENT });
  },
} satisfies WorkerHandler<typeof api>;
```

## Graph wiring

During infrastructure evaluation, Notation loads `entry` followed by every `files.runtime` file containing a declaration, deploying each according to how it wires into the resource graph:

| Mode | Behavior |
| :--- | :--- |
| Self-wired | Deploys `$worker` and `.bind()` `$lambda` declarations without an `infra/` import |
| Schema-only | Deploys `.schema()` or triggerless `$lambda` functions without a trigger until `infra/` attaches one |
| Hosted | Deploys `$durableObject` only when bound by a `$worker` or `worker()` |

## Prebuilt bundles

When deploying prebuilt artifacts or explicit `bundle()` builds, call `lambda()` on AWS or `worker()` on Cloudflare directly inside `infra/`:

::code-group

```ts [infra/external-lambda.ts (AWS)]
import { lambda } from "@notation/aws/lambda";
import { bundle } from "@notation/build/resources";

const legacyBundle = bundle({
  id: "legacy-orders",
  platform: "node",
  entry: "external/legacy-orders.ts",
});

export const legacyOrders = lambda({
  id: "legacy-orders",
  code: legacyBundle,
  timeout: 15,
});
```

```ts [infra/external-worker.ts (Cloudflare)]
import { bundle } from "@notation/build/resources";
import { entrypointType, worker } from "@notation/cloudflare/workers";
import type Webhooks from "../external/webhooks";

const webhooksBundle = bundle({
  id: "webhooks-bundle",
  platform: "workerd",
  entry: "external/webhooks.ts",
});

export const webhooks = worker({
  id: "webhooks",
  code: webhooksBundle,
  compatibilityDate: "2026-10-12",
  entrypoint: entrypointType<typeof Webhooks>(),
});
```

::

Use `addBindings(worker, bindings)` in `infra/` to attach additional Cloudflare bindings externally (external bindings are omitted from `WorkerEnv<typeof worker>`).

## Output protection

Declarations can expose deploy-time outputs, such as `url` on `$worker`. Because those values are unknown while bundling handlers, reading `api.url` directly inside handler code fails compilation and throws at runtime.

Project declaration outputs through `bindings()` or `env()` and read them from the function environment instead:

```ts [runtime/api.ts]
import { $worker, type WorkerHandler } from "@notation/cloudflare/workers";

export const api = $worker({
  id: "api",
  compatibilityDate: "2026-10-12",
  bindings: () => ({ SELF_URL: api.url }),
});

export default {
  async fetch(_request, env) {
    return Response.json({ url: env.SELF_URL });
  },
} satisfies WorkerHandler<typeof api>;
```

## Placement constraints

To split declarations cleanly across the infrastructure and runtime builds, keep one declaration per `runtime/` module as a top-level object literal, return plain object literals from `env()` and `bindings()`, and run handler tests that call `lambda.env()` with `--conditions=notation-runtime`.
