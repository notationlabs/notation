# Cloudflare Overview

`@notation/cloudflare` deploys Cloudflare Workers, Durable Objects, Containers, KV, R2, Secrets Store, and Account Tokens in TypeScript. High-level declarations infer `env` types and wire cross-resource bindings automatically.

## Installation

Install `@notation/core`, `@notation/cloudflare`, and `valibot` into your project:

```sh [Terminal]
@pm.add("@notation/core", "@notation/cloudflare", "valibot")
```

Add `@notation/cli` as a development dependency if your workspace does not include it yet (see [CLI Overview](../../cli/overview.md)):

```sh [Terminal]
@pm.dev("@notation/cli")
```

## Credentials

Every Cloudflare `plan`, `deploy`, and `destroy` operation reads two environment variables:

- **`CLOUDFLARE_API_TOKEN`** – API token with `Workers Scripts: Edit` plus permissions for any additional services you provision (such as `Containers: Edit` or `Account API Tokens: Edit`).
- **`CLOUDFLARE_ACCOUNT_ID`** – Target Cloudflare account ID for planning and creation.

Export both variables before running Notation commands:

```sh [Terminal]
export CLOUDFLARE_API_TOKEN="your-cloudflare-api-token"
export CLOUDFLARE_ACCOUNT_ID="your-cloudflare-account-id"
```

### Account binding

Each resource records the `CLOUDFLARE_ACCOUNT_ID` that created it, so updates and deletes always target that account. Changing `CLOUDFLARE_ACCOUNT_ID` on an existing `WorkerScript`, `KVNamespace`, or `R2Bucket` fails replacement checks rather than destroying live resources in another account.

## Quickstart

Deploy `orders-app` with an R2 bucket, a KV namespace, and a colocated `$worker` that reads both from typed `env`:

::code-group

```ts [notation.config.ts]
import { defineConfig } from "@notation/core/config";

export default defineConfig({
  app: "orders-app",
  entry: "infra/storage.ts",
  defaultStage: "dev",
});
```

```ts [infra/storage.ts]
import { deployment } from "@notation/core";
import { kv, r2 } from "@notation/cloudflare/resources";

const { app, stage } = deployment();

export const receiptsBucket = new r2.R2Bucket("bucket:receipts", {
  config: {
    BucketName: `${app}--${stage}--orders-receipts`,
    Jurisdiction: "default",
    StorageClass: "Standard",
  },
});

export const ordersCache = new kv.KVNamespace("kv:orders", {
  config: { Title: `${app}--${stage}--orders-cache` },
});
```

```ts [runtime/orders.ts]
import { $worker, json, type WorkerHandler } from "@notation/cloudflare/workers";
import { ordersCache, receiptsBucket } from "../infra/storage";

export const ordersWorker = $worker({
  id: "orders",
  compatibilityDate: "2026-10-12",
  bindings: () => ({
    RECEIPTS: receiptsBucket,
    CACHE: ordersCache,
    CONFIG: json({ maxItems: 50 }),
  }),
});

export default {
  async fetch(request, env) {
    const orderId = new URL(request.url).searchParams.get("id") ?? "latest";
    const cached = await env.CACHE.get(orderId);
    const receipt = await env.RECEIPTS.get(`${orderId}.json`);
    return Response.json({ orderId, cached, hasReceipt: receipt !== null, maxItems: env.CONFIG.maxItems });
  },
} satisfies WorkerHandler<typeof ordersWorker>;
```

::

Deploy the stage to Cloudflare:

```sh [Terminal]
notation deploy
```

`WorkerHandler<typeof ordersWorker>` derives `env.RECEIPTS` as `R2Bucket`, `env.CACHE` as `KVNamespace`, and `env.CONFIG` as `{ maxItems: number }`. Prefix explicit `BucketName` and `Title` values with `${app}--${stage}--` from `deployment()` whenever multiple stages share an account.

## Reference

### Subpath exports

`@notation/cloudflare` has no root `.` export and exposes three subpaths:

| Export | Description |
| :--- | :--- |
| `@notation/cloudflare/workers` | Worker and Durable Object declarations, binding helpers, and handler types |
| `@notation/cloudflare/kv` | Schema-validated JSON documents for Workers KV |
| `@notation/cloudflare/resources` | Low-level Cloudflare resource classes across six service namespaces |

Infra-only constructs (`worker()`, `WorkerGroup`, `addBindings()`) throw if called inside Worker runtime code.

### Low-level resource namespaces

Import `@notation/cloudflare/resources` to instantiate Cloudflare resources directly in `infra/`:

| Namespace | Resources |
| :--- | :--- |
| `workers` | `WorkerScript`, `WorkerSubdomain` |
| `kv` | `KVNamespace`, `KVValue`, `KVJsonValue` |
| `r2` | `R2Bucket` |
| `containers` | `ContainerApplication`, `ContainerImage`, `ContainerRegistry` |
| `secretsStore` | `SecretsStore`, `SecretsStoreSecret` |
| `tokens` | `AccountToken` |

### Physical naming

Cloudflare services enforce different character sets, separators, and length limits across resources (see [Physical Names](../../core/physical-names.md)):

- **Generated names (`<app>--<stage>--<base>-<instance>`, create-first replacement)** – Workers (`$worker`, `worker()`, `WorkerScript`) accept an `id` of 1–63 characters (`[a-z0-9-]`, no leading or trailing hyphen) with `ScriptName` capped at 54 characters; `AccountToken` `Name` is capped at 120 characters; `SecretsStoreSecret` `Name` is capped at 255 characters.
- **Validated identifiers** – `$durableObject` and `kvJson()` accept an `id` of 1–64 characters (`[A-Za-z0-9_-]`); `ContainerApplication` names use single hyphens (`<app>-<stage>-<id>-<hash>`, max 253 bytes, no leading digit or hyphen, no trailing hyphen, no `--`); default `ContainerImage` repositories use `<app>--<stage>--<id>`.
- **Explicit names (delete-first replacement guarded by loss protection)** – `R2Bucket` requires an immutable `BucketName` (3–64 characters, `[a-z0-9-]`, no leading or trailing hyphen); `KVNamespace` requires a unique `Title` (1–512 characters, updatable in place).
