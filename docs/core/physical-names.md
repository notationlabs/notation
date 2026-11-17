# Physical Names

Generating stage-scoped physical names prevents cross-stage collisions when multiple environments share one cloud account. It also lets Notation replace immutable resources create-first instead of taking live infrastructure down before recreating it.

## Stage isolation

Notation generates physical names using `<app>--<stage>--<base>-<instance>` plus any required provider ending such as `.fifo`. Because state keys each resource by its logical `id`, your TypeScript code uses one `id` across every environment while each stage provisions isolated cloud resources.

Declare resources with stable logical IDs rather than embedding stage names manually:

::code-group

```ts [infra/orders.ts (AWS)]
import * as v from "valibot";
import { queue } from "@notation/aws/sqs";

const Order = v.object({ orderId: v.string() });

export const orderQueue = queue({
  id: "orders",
  schema: Order,
});

export const ledgerQueue = queue({
  id: "ledger",
  fifo: true,
  schema: Order,
});
```

```ts [runtime/orders.ts (Cloudflare)]
import { $worker, type WorkerHandler } from "@notation/cloudflare/workers";

export const ordersWorker = $worker({
  id: "orders",
  compatibilityDate: "2026-10-12",
});

export default {
  async fetch() {
    return new Response("ok");
  },
} satisfies WorkerHandler<typeof ordersWorker>;
```

::

Deploying `app: "orders-app"` to `--stage prod` produces stage-scoped physical names with an 8-character random hex suffix:

| Declaration | Generated physical name |
| :--- | :--- |
| `queue({ id: "orders" })` | `orders-app--prod--orders-1a2b3c4d` |
| `queue({ id: "ledger", fifo: true })` | `orders-app--prod--ledger-1a2b3c4d.fifo` |
| `$worker({ id: "orders" })` | `orders-app--prod--orders-1a2b3c4d` |

When a generated name exceeds a cloud service's maximum length, Notation shortens `<app>--<stage>--<base>` while preserving the random instance suffix and required ending.

## Create-first replacement

During [`notation plan`](../cli/plan.md), uncreated physical names and pending replacements appear as `{ "$unknown": "after-apply" }` because random suffixes are only generated during [`notation deploy`](../cli/deploy.md):

```json [notation plan --json]
{
  "nodes": [
    {
      "id": "lambda:create-order",
      "type": "aws/lambda/LambdaFunction",
      "decision": "create",
      "params": {
        "FunctionName": { "$unknown": "after-apply" },
        "Handler": "index.handler"
      },
      "dependsOn": ["lambda:create-order:role", "lambda:create-order:zip"]
    }
  ]
}
```

Once deployed, updates reuse the persisted physical name. When an immutable property changes – or you pass `--replace` – Notation creates a new instance under a fresh physical name while the previous instance stays live, updates downstream dependents to point at the replacement, and deletes the retired instance at the end of the deploy.

If creating the replacement fails, the previous live resource and its state record stay intact. Resources without generated names (unless configured otherwise) replace delete-first instead (see [Reconciliation](./reconciliation.md)).

## Explicit names

Some cloud resources – such as Cloudflare [R2 buckets](../providers/cloudflare/r2.md) – require explicit user-defined names rather than generated physical names.

Use `deployment()` from `@notation/core` to include `app` and `stage` in explicit top-level names so stages never collide in a shared account:

```ts [infra/storage.ts]
import { deployment } from "@notation/core";
import { r2 } from "@notation/cloudflare/resources";

const { app, stage } = deployment();

export const receiptsBucket = new r2.R2Bucket("bucket:receipts", {
  config: {
    BucketName: `${app}--${stage}--receipts`,
    Jurisdiction: "default",
    StorageClass: "Standard",
  },
});
```

A resource can also reference its own generated `physicalName` parameter without creating a dependency cycle, because deploy populates the generated name before resolving inputs.
