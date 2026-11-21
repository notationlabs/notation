# Cloudflare Workers

Declare Cloudflare Workers alongside their TypeScript handlers with typed `env` bindings, service RPC entrypoints, and `workers.dev` URLs. Notation bundles each module for `workerd`, wires cross-resource bindings and secrets, and performs create-first replacements.

Workers require `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` with `Workers Scripts: Edit` (see [Cloudflare Overview](./overview.md)).

## Multi-binding Workers

Declare a Worker in a `runtime/` module with `$worker` and export a `default` handler typed with `WorkerHandler<typeof worker>`. Return KV namespaces, R2 buckets, credentials, Secrets Store entries, JSON objects, or plain strings from `bindings()`:

::code-group

```ts [runtime/orders.ts]
import { $worker, json, type WorkerHandler } from "@notation/cloudflare/workers";
import { orderCache, receiptsBucket, stripeKey, webhookSecret } from "../infra/orders";

export const ordersWorker = $worker({
  id: "orders",
  compatibilityDate: "2026-10-12",
  bindings: () => ({
    CACHE: orderCache,
    RECEIPTS: receiptsBucket,
    STRIPE_KEY: stripeKey,
    WEBHOOK_SECRET: webhookSecret,
    LIMITS: json({ maxItems: 50, currencies: ["USD", "EUR"] }),
    STAGE_LABEL: "prod",
  }),
});

export default {
  async fetch(_request, env) {
    const signingKey = await env.WEBHOOK_SECRET.get();
    const cached = await env.CACHE.get("latest-order");
    return Response.json({
      maxItems: env.LIMITS.maxItems,
      hasSigningKey: Boolean(signingKey),
      cached,
    });
  },
} satisfies WorkerHandler<typeof ordersWorker>;
```

```ts [infra/orders.ts]
import { kv, r2, secretsStore } from "@notation/cloudflare/resources";
import { sources } from "@notation/std/resources";

export const orderCache = new kv.KVNamespace("order-cache", {
  config: { Title: "orders-cache" },
});

export const receiptsBucket = new r2.R2Bucket("receipts", {
  config: { BucketName: "orders-receipts", Jurisdiction: "default", StorageClass: "Standard" },
});

export const stripeKey = new sources.Env("stripe-key", {
  config: { key: "STRIPE_SECRET_KEY" },
}).credentials.value;

const store = new secretsStore.SecretsStore("account-store");

export const webhookSecret = new secretsStore.SecretsStoreSecret("webhook-signing-secret", {
  config: {
    Value: new sources.Env("webhook-secret", {
      config: { key: "WEBHOOK_SIGNING_SECRET" },
    }).credentials.value,
  },
  dependencies: { store },
});
```

::

Place at most one top-level `$worker` call per `runtime/` module with an object literal and a `default` export (`ExportedHandler` or `WorkerEntrypoint` subclass). Inside the `workerd` bundle, `$worker` reduces to `{ id }` and `WorkerHandler` strips `@notation/resource` types from `env` (see [Runtime Declarations](../../core/declarations.md)).

### Worker URLs

By default, every Worker gets a `workers.dev` URL exposed on `.url` (requiring an existing `workers.dev` subdomain on your Cloudflare account). Pass `.url` into `bindings()` with `text` so a Worker can bind its own URL or another Worker's URL without dependency cycles:

```ts [runtime/api.ts]
import { text } from "@notation/resource";
import { $worker, type WorkerHandler } from "@notation/cloudflare/workers";

export const api = $worker({
  id: "api",
  compatibilityDate: "2026-10-12",
  bindings: () => ({ CALLBACK_URL: text`${api.url}/callback` }),
});

export default {
  async fetch(_request, env) {
    return Response.json({ callbackUrl: env.CALLBACK_URL });
  },
} satisfies WorkerHandler<typeof api>;
```

Runtime handlers cannot read `api.url` directly because outputs resolve only at deploy; always bind `.url` into `bindings()` and read it from `env`. Set literal `url: false` on internal Workers to skip `workers.dev` and remove `.url` from the type.

### Worker loaders

Call `workerLoader()` inside `bindings()` to attach a Cloudflare Worker Loader binding typed as `WorkerLoader` on `env`:

```ts [runtime/runner.ts]
import { $worker, workerLoader, type WorkerHandler } from "@notation/cloudflare/workers";

export const runner = $worker({
  id: "runner",
  compatibilityDate: "2026-10-12",
  bindings: () => ({ LOADER: workerLoader() }),
});

export default {
  async fetch(_request, env) {
    const sandbox = env.LOADER.get("sandbox", async () => ({
      compatibilityDate: "2026-10-12",
      mainModule: "index.js",
      modules: { "index.js": "export default { fetch: () => new Response('ok') }" },
    }));
    return sandbox.getEntrypoint().fetch("http://sandbox/");
  },
} satisfies WorkerHandler<typeof runner>;
```

`workerLoader()` provisions no cloud resource on its own, so deploy creates and deletes nothing for the binding itself.

## Service RPC

Declare a `WorkerEntrypoint` subclass before `$worker`, export it as `default`, and pass it to `entrypoint` so calling Workers receive typed RPC methods on `env` instead of a plain `Fetcher`:

::code-group

```ts [runtime/orders.ts]
import { WorkerEntrypoint } from "cloudflare:workers";
import { $worker, type WorkerEnv } from "@notation/cloudflare/workers";

export type CreateOrderInput = { customerId: string; totalCents: number };

export default class OrdersService extends WorkerEntrypoint<WorkerEnv<typeof orders>> {
  async createOrder(input: CreateOrderInput) {
    return { orderId: crypto.randomUUID(), region: this.env.REGION, totalCents: input.totalCents };
  }
}

export const orders = $worker({
  id: "orders",
  compatibilityDate: "2026-10-12",
  bindings: () => ({ REGION: "us-east" }),
  entrypoint: OrdersService,
  url: false,
});
```

```ts [runtime/api.ts]
import { $worker, type WorkerHandler } from "@notation/cloudflare/workers";
import { orders, type CreateOrderInput } from "./orders";

export const api = $worker({
  id: "api",
  compatibilityDate: "2026-10-12",
  bindings: () => ({ ORDERS: orders }),
});

export default {
  async fetch(request, env) {
    const payload = (await request.json()) as CreateOrderInput;
    return Response.json(await env.ORDERS.createOrder(payload), { status: 201 });
  },
} satisfies WorkerHandler<typeof api>;
```

::

`api` never bundles `OrdersService`'s implementation. Because service bindings emit as [contributions](../../core/outputs-and-contributions.md), two Workers can bind each other or bind themselves (`SELF: api`) without creating dependency cycles.

## External Workers

Use `worker()` in `infra/` when a Worker's code comes from a custom `bundle()` or a prebuilt ES module file. Pair `import type` with `entrypointType<typeof MyEntrypoint>()` so infra code never loads `"cloudflare:workers"`:

::code-group

```ts [infra/webhooks.ts]
import { bundle } from "@notation/build/resources";
import { entrypointType, worker } from "@notation/cloudflare/workers";
import type WebhookIngest from "../external/webhook-ingest";

const webhookBundle = bundle({
  id: "webhook-ingest",
  platform: "workerd",
  entry: "external/webhook-ingest.ts",
});

export const webhookWorker = worker({
  id: "webhook-ingest",
  code: webhookBundle,
  compatibilityDate: "2026-10-12",
  bindings: () => ({ SOURCE: "github" }),
  entrypoint: entrypointType<typeof WebhookIngest>(),
  url: false,
});
```

```ts [infra/legacy-router.ts]
import { worker } from "@notation/cloudflare/workers";

export const legacyRouter = worker({
  id: "legacy-router",
  code: { type: "file", path: "external/router.mjs" },
  compatibilityDate: "2026-10-12",
  bindings: () => ({ MODE: "proxy" }),
});
```

::

Notation checks top-level exports statically for `workerd` compatibility and Durable Object hosts, without verifying `entrypointType` against runtime exports.

## Shared bindings

Call `addBindings()` from an `infra/` module during top-level evaluation to attach bindings to a Worker declared elsewhere:

```ts [infra/webhooks.ts]
import { addBindings } from "@notation/cloudflare/workers";
import { orders } from "../runtime/orders";
import { webhookWorker } from "./webhooks-worker";

addBindings(orders, { WEBHOOKS: webhookWorker });
```

`WorkerEnv<typeof worker>` excludes bindings added with `addBindings()`, so handlers reading those keys must narrow `env` explicitly.

## Runtime constraints

Worker modules run in `workerd` rather than Node.js and must follow three rules:

- **Restricted exports** – `workerd` rejects primitive top-level exports and `export * as ns`; keep constants unexported or place them in `shared/`.
- **Node built-ins** – `"nodejs_compat"` is enabled on every Worker so standard `node:` built-ins work inside bundles.
- **Infra isolation** – Never import `@notation/cloudflare/resources` or call `worker()`, `WorkerGroup`, or `addBindings()` inside runtime modules.

## Reference

### `$worker` declaration

`$worker(config)` is exported from `@notation/cloudflare/workers`:

| Parameter | Description |
| :--- | :--- |
| `id` | Required immutable `string` Worker identifier |
| `compatibilityDate` | Required Cloudflare compatibility date in `YYYY-MM-DD` format |
| `compatibilityFlags` | Optional `string[]` of extra Cloudflare compatibility flags |
| `bindings` | Optional thunk returning a plain object literal of bindings |
| `url` | Optional `boolean` enabling `workers.dev` and `.url`, default `true` |
| `entrypoint` | Optional `WorkerEntrypoint` subclass typing service bindings as `Service<E>` |

`id` accepts `1` to `63` characters matching `[a-z0-9-]` with no leading or trailing hyphen; changing `id` replaces the Worker, and the physical `ScriptName` `<app>--<stage>--<id>-<instance>` is capped at 54 characters. `"nodejs_compat"` is always included in `compatibilityFlags`.

`bindings` must return an object literal with no object spread `...` or computed keys and is evaluated after all infra modules load. Setting literal `url: false` removes `.url` from the TypeScript type and throws on access, while a non-literal `boolean` keeps `.url` in the type and throws at evaluation when `false`. `entrypoint` must be declared in the same module before `$worker` and exported as `default`.

### `worker()` resource

`worker(config)` is exported from `@notation/cloudflare/workers` for infra modules and accepts all `$worker` options with two differences:

| Parameter | Description |
| :--- | :--- |
| `code` | Required relative file path `{ type: "file", path }` or `"workerd"` `bundle()` resource |
| `entrypoint` | Optional type-only handle returned by `entrypointType<typeof Entrypoint>()` |

`code` resolves file paths relative to the project root and rejects `"node"` bundles (see [Bundles](../../authoring/bundles.md)).

### `WorkerGroup` properties

Both `$worker` and `worker()` create a `WorkerGroup` resource group, detectable with `isWorkerGroup(value)`:

| Property | Description |
| :--- | :--- |
| `code` | Owned `std/fs/File` instance or external `Bundle` reference |
| `script` | Managed `cloudflare/workers/WorkerScript` resource instance |
| `subdomain` | Managed `cloudflare/workers/WorkerSubdomain` resource instance when `url` is not `false` |
| `containers` | Array of `{ namespaceId, image, application }` entries for container-backed Durable Objects |

`containers` holds `ContainerImage` and `ContainerApplication` instances for each container-backed namespace (see [Containers](./containers.md)).

### `WorkerEnv` binding map

Every value returned from `bindings()` maps to a `@cloudflare/workers-types` type on `WorkerEnv<typeof worker>`:

| Binding | Type |
| :--- | :--- |
| `string` | `string` |
| `OutputRef<string>` or `Derived<string>` | `string` |
| `CredentialRef<string>` | `string` |
| `SecretsStoreSecret` | `SecretsStoreSecret` |
| `json(value)` | Inferred `T` |
| `KVNamespace` | `KVNamespace` |
| `R2Bucket` | `R2Bucket` |
| `$durableObject(...)` | `DurableObjectNamespace<I>` |
| `$worker(...)` or `worker(...)` | `Service<E>` or `Fetcher` |
| `workerLoader()` | `WorkerLoader` |

Observe these binding rules:

- **Plain-text values** – Strings, `json()`, non-credential `OutputRef<string>`, and `Derived<string>` (`text`, `map`, `all`) bind as plain text stored in state and printed in `plan`; never bind secrets this way.
- **`StateRef` rejected** – Passing a `StateRef` to `bindings()` fails; use `outputRef()` instead.
- **R2 jurisdictions** – `R2Bucket` forwards non-`"default"` `Jurisdiction` values (including `OutputRef` and `Derived`, shown as unknown in `plan` until resolved); `Jurisdiction` cannot be a `CredentialRef`.
- **Durable Object hosting** – Binding a `$durableObject` and exporting its class by name (no `export *`) makes that Worker the host (see [Durable Objects](./durable-objects.md)).
- **`json(value)`** – Accepts JSON primitives, arrays, plain objects, and interfaces without functions; key order is not preserved.
- **Secret bindings** – `CredentialRef<string>` creates a `secret_text` binding (`string` in `env`); `SecretsStoreSecret` creates a `secrets_store_secret` binding (`await env.SECRET.get()`). Updates re-upload only changed credentials and delete removed secrets (see [Secrets](./secrets.md)).

### `addBindings()` rules

- **Call timing** – Call `addBindings(worker, bindings)` only from an `infra/` module while infra modules load (calling inside an `onEvaluationEnd` callback or runtime module fails).
- **Unique keys** – Added binding keys cannot collide with the target Worker's own `bindings()` or another `addBindings()` call on the same Worker.
- **Type exclusion** – `WorkerEnv<typeof worker>` does not include bindings attached via `addBindings()`.

### Deployment lifecycle

- **Create-first replacements** – Replacing a Worker (`--replace` or changing `id`) creates the new script before deleting the old one, keeping traffic live if creation fails.
- **Account guard** – Changing `CLOUDFLARE_ACCOUNT_ID` on an existing Worker fails replacement checks to protect hosted Durable Objects; destroy the old stage first.
- **Existing scripts** – Creating a Worker fails if an unmanaged Cloudflare script already uses the generated `ScriptName`.
- **Dependent deletions** – Managed referencing Workers delete together with their target; unmanaged script, Pages project, dispatch namespace, or tail producer references abort deletion.
- **Gradual rollouts** – Updates abort if two or more script versions serve non-zero traffic in Cloudflare; finish or cancel the rollout before deploying.
