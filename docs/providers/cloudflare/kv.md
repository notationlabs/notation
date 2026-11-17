# KV

Provision Cloudflare Workers KV namespaces, manage schema-checked JSON configuration across infrastructure modules, and read typed values in [Workers](./workers.md).

Deploying KV resources requires `CLOUDFLARE_ACCOUNT_ID` and a `CLOUDFLARE_API_TOKEN` with the **Workers KV Storage: Edit** permission (see [Cloudflare Overview](./overview.md)).

## KV namespaces

Declare a namespace with `kv.KVNamespace` from `@notation/cloudflare/resources`, then bind it inside `$worker` or `worker()`.

Binding a `KVNamespace` automatically adds a deployment dependency and types the binding as `KVNamespace` on `env`:

::code-group

```ts [infra/config.ts]
import { kv } from "@notation/cloudflare/resources";

export const ordersKv = new kv.KVNamespace("orders-kv", {
  config: {
    Title: "orders-config",
  },
});
```

```ts [runtime/orders-api.ts]
import { $worker, type WorkerHandler } from "@notation/cloudflare/workers";
import { ordersKv } from "../infra/config";

export const worker = $worker({
  id: "orders-api",
  compatibilityDate: "2026-10-12",
  bindings: () => ({ ORDERS_KV: ordersKv }),
});

export default {
  async fetch(request, env) {
    const orderId = new URL(request.url).searchParams.get("orderId");
    if (!orderId) return new Response("missing orderId", { status: 400 });

    const cached = await env.ORDERS_KV.get(`order:${orderId}`);
    if (!cached) return new Response("not found", { status: 404 });

    return new Response(cached, {
      headers: { "content-type": "application/json" },
    });
  },
} satisfies WorkerHandler<typeof worker>;
```

::

Include an app or stage qualifier in `Title` when sharing an account across stages, because Notation refuses to adopt an existing namespace with the same title. You can also attach a namespace externally with `addBindings(worker, { ORDERS_KV: ordersKv })`, though externally added bindings are not reflected in `WorkerEnv<typeof worker>`.

## Shared JSON documents

Use `kvJson()` from `@notation/cloudflare/kv` to manage a single JSON document in one KV key. Multiple infrastructure modules can contribute keys to the document, validated together at deploy time against a shared [Standard Schema V1](https://standardschema.dev) validator.

Define the schema in `shared/`, declare the document in `infra/config.ts`, contribute settings from `infra/webhooks.ts`, import both in `infra/main.ts`, and read the decoded config in `runtime/orders-api.ts`:

::code-group

```ts [shared/orders.ts]
import * as v from "valibot";

export const ORDERS_CONFIG_KEY = "orders-config";

export const OrdersConfig = v.object({
  features: v.record(v.string(), v.boolean()),
  webhooks: v.object({
    enabled: v.boolean(),
    endpointPath: v.string(),
  }),
  namespaceId: v.optional(v.string()),
  namespaceTag: v.optional(v.string()),
});
```

```ts [infra/config.ts]
import { text } from "@notation/resource";
import { kvJson } from "@notation/cloudflare/kv";
import { kv } from "@notation/cloudflare/resources";
import { ORDERS_CONFIG_KEY, OrdersConfig } from "../shared/orders";

export const ordersKv = new kv.KVNamespace("orders-kv", {
  config: { Title: "orders-config" },
});

export const ordersConfig = kvJson({
  id: "orders-config",
  namespace: ordersKv,
  key: ORDERS_CONFIG_KEY,
  schema: OrdersConfig,
  value: {
    features: { checkout: true },
    namespaceTag: text`kv:${ordersKv.outputRef("NamespaceId").map((id) => id.slice(0, 8))}`,
  },
});

ordersConfig.contribute({
  namespaceId: ordersKv.outputRef("NamespaceId"),
});
```

```ts [infra/webhooks.ts]
import { ordersConfig } from "./config";

ordersConfig.contribute({
  features: { webhookRetries: true },
  webhooks: {
    enabled: true,
    endpointPath: "/webhooks/orders",
  },
});
```

```ts [infra/main.ts]
import "./config";
import "./webhooks";
```

```ts [runtime/orders-api.ts]
import {
  $worker,
  KVJsonError,
  readKVJson,
  type WorkerHandler,
} from "@notation/cloudflare/workers";
import { ordersKv } from "../infra/config";
import { ORDERS_CONFIG_KEY, OrdersConfig } from "../shared/orders";

export const worker = $worker({
  id: "orders-api",
  compatibilityDate: "2026-10-12",
  bindings: () => ({ ORDERS_KV: ordersKv }),
});

export default {
  async fetch(_request, env) {
    try {
      const config = await readKVJson(
        env.ORDERS_KV,
        ORDERS_CONFIG_KEY,
        OrdersConfig,
        { cacheTtl: 300 },
      );
      if (!config) return new Response("config not ready", { status: 404 });
      return Response.json(config);
    } catch (error) {
      if (error instanceof KVJsonError) {
        return Response.json(
          { key: error.key, issues: error.issues },
          { status: 500 },
        );
      }
      throw error;
    }
  },
} satisfies WorkerHandler<typeof worker>;
```

::

### Partial contributions

Both `value` and `.contribute()` make object properties optional recursively while keeping arrays and scalars whole, so each module only specifies its own slice of the document. You can pass resource outputs and derived values (`text`, `.map()`, `all()`) at any depth.

During `plan` and `deploy`, Notation merges `value` and all contributions by object key and validates the combined document against `schema`. Two contributions setting the same scalar or array path to different values throw `ContributionConflictError` (see [Outputs and Contributions](../../core/outputs-and-contributions.md)).

### JSON validation

`kvJson()` checks at compile time that the schema's input type is JSON-compatible, rejecting functions and built-ins such as `Date`, `RegExp`, `Map`, `Set`, or `Promise`. Schema outputs remain unconstrained, so a validator can transform stored JSON strings into runtime types like `Date` when read with `readKVJson()`.

This schema accepts an ISO date string at deploy time and decodes it into a `Date` inside a Worker:

```ts [infra/schedule-flags.ts]
import * as v from "valibot";
import { kvJson } from "@notation/cloudflare/kv";
import { ordersKv } from "./config";

const ScheduleFlags = v.object({
  enabled: v.boolean(),
  startsAt: v.pipe(v.string(), v.transform((iso) => new Date(iso))),
});

export const scheduleFlags = kvJson({
  id: "schedule-flags",
  namespace: ordersKv,
  key: "schedule-flags",
  schema: ScheduleFlags,
  value: { enabled: true, startsAt: "2026-10-12T00:00:00Z" },
});
```

At deploy time, `plan` and `deploy` also reject values that `JSON.stringify` drops or alters – including `NaN`, `Infinity`, `undefined`, non-plain objects, sparse arrays, functions, `__proto__` keys, and payloads larger than 25 MiB.

## Reading JSON in Workers

Call `readKVJson(namespace, key, schema, options?)` from `@notation/cloudflare/workers` to read a key as text, parse the JSON, and validate it against `schema`:

- **Missing key** – Returns `undefined` when the key does not exist (including briefly up to ~60 seconds after an initial deploy due to KV propagation).
- **Invalid JSON** – Throws `KVJsonError` with `key` set, `issues` empty (`[]`), and `cause` set to the `JSON.parse` error.
- **Schema mismatch** – Throws `KVJsonError` with `key` set and `issues` populated from the Standard Schema validator.

Pass Cloudflare KV `get` options such as `{ cacheTtl: 300 }` in `options` while keeping `type` locked to `"text"`. Import the schema from a `shared/` module so infra and Workers evaluate the same validator (see [Types](../../core/types.md)).

## Raw key resources

Use `kv.KVValue` or `kv.KVJsonValue` directly from `@notation/cloudflare/resources` when you need to seed plain UTF-8 text or build a custom resource group without `kvJson()`.

Seed a plain-text routing manifest in `ordersKv` using `kv.KVValue`:

```ts [infra/routes.ts]
import { kv } from "@notation/cloudflare/resources";
import { ordersKv } from "./config";

export const orderRoutes = new kv.KVValue("orders:routes", {
  config: {
    Key: "routes/v1",
    Value: "/orders\n/webhooks/orders\n",
  },
  dependencies: { namespace: ordersKv },
});
```

## Eventual consistency

Cloudflare Workers KV propagates writes asynchronously across edge locations:

- **Deploy-time confirmation** – `create` and `update` poll Cloudflare until reads return the written value, retrying new-namespace propagation and timing out after ~60 seconds on concurrent external writes.
- **Runtime windows** – Worker reads can miss new keys or see stale values for up to ~60 seconds after writes, and recently deleted external keys can briefly appear present.

Cloudflare also caps KV values at 25 MiB. Because Notation stores KV values in state, use [R2](./r2.md) for large blobs or multi-megabyte payloads.

## Reference

### `kvJson`

`kvJson(config)` from `@notation/cloudflare/kv` returns a `KVJsonGroup` wrapping a `KVJsonValue` resource (`kv-json:<id>`).

`KVJsonConfig<S>` accepts five parameters:

| Parameter | Description |
| :--- | :--- |
| `id` | Required unique `string` state identifier, never sent to Cloudflare |
| `namespace` | Required `KVNamespaceInstance` target namespace resource |
| `key` | Required `string` KV key name inside the namespace |
| `schema` | Required `StandardSchemaV1` validator with a JSON-compatible input type |
| `value` | Optional `DeepInput<JsonPartial<SchemaInput<S>>>` initial document subset |

`id` accepts `1` to `64` ASCII letters, digits, hyphens, or underscores. `schema` allows `unknown` and `any` at any depth, and `value` accepts `OutputRef` and `Derived` values at any depth.

`KVJsonGroup` exposes three properties:

| Property | Description |
| :--- | :--- |
| `schema` | `S` validator passed to `kvJson()` |
| `value` | `KVJsonValueInstance` underlying `kv.KVJsonValue` resource |
| `contribute` | Method merging partial object contributions into `value` |

`contribute(value)` accepts `DeepInput<JsonPartial<SchemaInput<S>>>`.

### `readKVJson`

`readKVJson(namespace, key, schema, options?)` from `@notation/cloudflare/workers` reads, parses, and validates a KV JSON document:

| Parameter | Description |
| :--- | :--- |
| `namespace` | `Pick<KVNamespace, "get">` Cloudflare KV binding from Worker `env` |
| `key` | `string` KV key name |
| `schema` | `StandardSchemaV1` shared Standard Schema V1 validator |
| `options` | Optional `Omit<KVNamespaceGetOptions<"text">, "type">` KV `get` options |

Returns `Promise<StandardSchemaV1.InferOutput<S> | undefined>`. Pass Cloudflare KV `get` options such as `cacheTtl` in `options`.

### `KVJsonError`

`KVJsonError` from `@notation/cloudflare/workers` extends `Error` with four properties:

| Property | Description |
| :--- | :--- |
| `name` | Literal `"KVJsonError"` error name |
| `key` | `readonly string` KV key that failed parsing or validation |
| `issues` | `readonly StandardSchemaV1.Issue[]` validation issues |
| `cause` | Optional `unknown` underlying `JSON.parse` error |

`issues` is `[]` when `JSON.parse` fails, and `cause` is set only when the stored text is not valid JSON.

### `KVNamespace`

`kv.KVNamespace` (`cloudflare/kv/KVNamespace`) from `@notation/cloudflare/resources` manages a Workers KV namespace:

| Property | Description |
| :--- | :--- |
| `Title` | Required mutable `Input<string>` namespace name |
| `Jurisdiction` | Optional immutable `Input<string>` residency jurisdiction |
| `AccountId` | Derived immutable `string` from `CLOUDFLARE_ACCOUNT_ID` |
| `NamespaceId` | Computed `string` Cloudflare namespace ID |

`Title` must be `1` to `512` characters and unique within the Cloudflare account; updates rename in place. `Jurisdiction` accepts `"eu"`, `"fedramp"`, or `"us"`. Reference `NamespaceId` via `.outputRef("NamespaceId")`.

Creation checks whether a namespace with `Title` already exists and fails rather than adopting unmanaged namespaces. Changing `AccountId` or `Jurisdiction` is blocked to avoid deleting stored keys; forced `--replace` requires `--override-loss-protection <id>` (see [`notation destroy`](../../cli/destroy.md)).

### `KVValue`

`kv.KVValue` (`cloudflare/kv/KVValue`) from `@notation/cloudflare/resources` stores a raw UTF-8 string in a KV key (`dependencies: { namespace }`):

| Property | Description |
| :--- | :--- |
| `Key` | Required immutable `Input<string>` key name |
| `Value` | Required mutable `Input<string>` raw UTF-8 text up to 25 MiB |
| `AccountId` | Derived `string` account ID from `dependencies.namespace` |
| `NamespaceId` | Derived `string` namespace ID from `dependencies.namespace` |

`Key` must be `1` to `512` UTF-8 bytes and cannot be `"."` or `".."`. `Value` preserves `\n` vs `\r\n` line endings and leading BOMs.

Create fails if the key already exists. Changing `Key` or `NamespaceId` creates the new key before deleting the old key, failing safely if the target key already exists.

### `KVJsonValue`

`kv.KVJsonValue` (`cloudflare/kv/KVJsonValue`) from `@notation/cloudflare/resources` stores normalized, contributable JSON (`dependencies: { namespace }`):

| Property | Description |
| :--- | :--- |
| `Key` | Required immutable `Input<string>` key name |
| `Value` | Required mutable contributable `Input<Json>` strict JSON up to 25 MiB |
| `AccountId` | Derived `string` account ID from `dependencies.namespace` |
| `NamespaceId` | Derived `string` namespace ID from `dependencies.namespace` |

`Key` must be `1` to `512` UTF-8 bytes and cannot be `"."` or `".."`. `Value` is encoded with sorted keys.

`KVJsonValue` shares the same non-overwrite and create-first rename rules as `KVValue`. If external writes leave non-JSON text in the key, `notation plan --drift` detects drift and `notation deploy` restores the declared document.

### Package exports

KV APIs span three `@notation/cloudflare` entrypoints:

| Subpath | Exports |
| :--- | :--- |
| `@notation/cloudflare/kv` | `kvJson`, `KVJsonGroup`, `Json`, `JsonPartial`, `KVJsonConfig` |
| `@notation/cloudflare/workers` | `readKVJson`, `KVJsonError` |
| `@notation/cloudflare/resources` | `kv.KVNamespace`, `kv.KVValue`, `kv.KVJsonValue` |
