# Types

Notation threads schemas and cloud references from `shared/` and `infra/` straight into your handler signatures. Mismatched event shapes, missing bindings, and accidental string coercions fail `tsc`, while runtime boundaries validate incoming payloads automatically.

## Single source of truth

Define a [Standard Schema v1](https://standardschema.dev) validator once in `shared/` using any compatible library such as Valibot, Zod, ArkType, or Effect Schema, then import that same validator in both `runtime/` and `infra/`:

::code-group

```ts [runtime/create-order.ts]
import { $lambda, apiGateway, type LambdaHandler } from "@notation/aws/lambda";
import { CreateOrder } from "../shared/orders";

export const createOrder = $lambda({
  id: "create-order",
  event: () => apiGateway.schema(CreateOrder),
});

export const handler: LambdaHandler<typeof createOrder> = async (event) => {
  const { body } = await createOrder.decode(event);
  return {
    statusCode: 201,
    body: JSON.stringify({ orderId: body.orderId, quantity: body.quantity }),
  };
};
```

```ts [infra/api.ts]
import { api, router } from "@notation/aws/api-gateway";
import { createOrder } from "../runtime/create-order";

const ordersApi = api({ id: "orders-api" });
router(ordersApi).post("/orders", () => createOrder);
```

```ts [shared/orders.ts]
import * as v from "valibot";

export const CreateOrder = v.object({
  orderId: v.string(),
  quantity: v.pipe(v.number(), v.integer(), v.minValue(1)),
});
```

::

Because `createOrder` carries `CreateOrder` in its type, `body.orderId` and `body.quantity` are inferred without manual annotations, and wiring `createOrder` to an incompatible trigger such as an SQS queue fails typechecking immediately. Share the exact validator import from `shared/` so compile-time and deploy-time checks agree.

## Combining deploy outputs

Cloud endpoints, queue URLs, and ARNs do not exist until deployment, so Notation models them as typed reference objects rather than strings. Passing an output reference into a function expecting `string` fails typechecking, and interpolating one directly throws at runtime.

Use `` text`...` `` and `all([...]).map(...)` from `@notation/resource` to build derived strings that resolve during deployment:

```ts [infra/callback.ts]
import { all, text } from "@notation/resource";
import { ordersWorker } from "../runtime/orders-worker";
import { orderBus, orderQueue } from "./messaging";

const callbackUrl = text`${ordersWorker.url}/webhooks`;

const summary = all([orderQueue.url, orderBus.arn]).map(
  ([url, arn]) => `${url} -> ${arn}`,
);
```

When you bind `ordersWorker.url` into `env()` or `bindings()`, Notation unwraps the reference type back to `string` inside your handler.

## Runtime validation

Compile-time types protect your code, while runtime boundaries validate untrusted requests, queue messages, and stored JSON documents.

### AWS request decoding

Call `decode()` on `$lambda` to parse and validate incoming API Gateway, SQS, or EventBridge payloads, catching `DecodeError` to return structured validation failures:

```ts [runtime/create-order.ts]
import {
  $lambda,
  apiGateway,
  DecodeError,
  type LambdaHandler,
} from "@notation/aws/lambda";
import { CreateOrder } from "../shared/orders";

export const createOrder = $lambda({
  id: "create-order",
  event: () => apiGateway.schema(CreateOrder),
});

export const handler: LambdaHandler<typeof createOrder> = async (event) => {
  try {
    const { body } = await createOrder.decode(event);
    return { statusCode: 201, body: JSON.stringify(body) };
  } catch (error) {
    if (!(error instanceof DecodeError)) throw error;
    return { statusCode: 400, body: JSON.stringify({ issues: error.issues }) };
  }
};
```

### Cloudflare KV validation

On Cloudflare, `$worker` propagates `bindings()` types directly onto `env`, and `readKVJson()` validates stored JSON documents against a shared schema at runtime:

::code-group

```ts [runtime/orders-api.ts]
import {
  $worker,
  readKVJson,
  type WorkerHandler,
} from "@notation/cloudflare/workers";
import { configNamespace } from "../infra/flags";
import { OrderFlags } from "../shared/flags";

export const ordersApi = $worker({
  id: "orders-api",
  compatibilityDate: "2026-10-12",
  bindings: () => ({ CONFIG: configNamespace }),
});

export default {
  async fetch(_request, env) {
    const flags = await readKVJson(env.CONFIG, "order-flags", OrderFlags);
    return Response.json({ expressCheckout: flags?.expressCheckout ?? false });
  },
} satisfies WorkerHandler<typeof ordersApi>;
```

```ts [shared/flags.ts]
import * as v from "valibot";

export const OrderFlags = v.object({
  expressCheckout: v.boolean(),
});
```

::
