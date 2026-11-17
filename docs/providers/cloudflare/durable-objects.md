# Durable Objects

Declare Cloudflare Durable Objects alongside their classes with SQLite storage, typed RPC stubs, and optional attached containers. Notation detects the hosting Worker, generates storage migrations across class renames and host transfers, and guards stateful objects against accidental deletion.

Durable Objects are hosted by [Workers](./workers.md) and require `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` with `Workers Scripts: Edit`.

## Stateful namespaces

Define your `DurableObject` subclass and `$durableObject` declaration in a `runtime/` module. A namespace deploys only when bound by a Worker; whichever Worker binds it and exports its class by name becomes the host:

::code-group

```ts [runtime/order-coordinator.ts]
import { DurableObject } from "cloudflare:workers";
import { $durableObject } from "@notation/cloudflare/workers";

export class OrderCoordinator extends DurableObject {
  async addItem(sku: string, quantity: number): Promise<number> {
    const next = ((await this.ctx.storage.get<number>(sku)) ?? 0) + quantity;
    await this.ctx.storage.put(sku, next);
    return next;
  }

  async getItems(): Promise<Record<string, number>> {
    return Object.fromEntries(await this.ctx.storage.list<number>());
  }
}

export const orderCoordinator = $durableObject({
  id: "order-coordinator",
  class: OrderCoordinator,
});
```

```ts [runtime/api.ts]
import { $worker, type WorkerHandler } from "@notation/cloudflare/workers";
import { orderCoordinator } from "./order-coordinator";

export { OrderCoordinator } from "./order-coordinator";

export const api = $worker({
  id: "api",
  compatibilityDate: "2026-10-12",
  bindings: () => ({ ORDER_COORDINATOR: orderCoordinator }),
});

export default {
  async fetch(request, env) {
    const orderId = new URL(request.url).searchParams.get("orderId") ?? "default";
    const stub = env.ORDER_COORDINATOR.getByName(orderId);
    if (request.method === "POST") {
      const { sku, quantity } = await request.json<{ sku: string; quantity: number }>();
      return Response.json({ orderId, sku, total: await stub.addItem(sku, quantity) });
    }
    return Response.json({ orderId, items: await stub.getItems() });
  },
} satisfies WorkerHandler<typeof api>;
```

::

Because `OrderCoordinator` extends `DurableObject`, `env.ORDER_COORDINATOR` provides typed RPC calls (`stub.addItem`, `stub.getItems`). Notation keeps `"cloudflare:workers"` and the class implementation strictly inside the Worker bundle (see [Runtime Declarations](../../core/declarations.md)).

## Cross-Worker RPC

Any other Worker can bind `orderCoordinator` without re-exporting `OrderCoordinator`. Notation uploads the hosting Worker first and wires the guest Worker's binding to the host script:

```ts [runtime/fulfillment.ts]
import { $worker, type WorkerHandler } from "@notation/cloudflare/workers";
import { orderCoordinator } from "./order-coordinator";

export const fulfillment = $worker({
  id: "fulfillment",
  compatibilityDate: "2026-10-12",
  bindings: () => ({ ORDER_COORDINATOR: orderCoordinator }),
});

export default {
  async fetch(request, env) {
    const orderId = new URL(request.url).searchParams.get("orderId") ?? "default";
    const items = await env.ORDER_COORDINATOR.getByName(orderId).getItems();
    return Response.json({ source: "fulfillment", orderId, items });
  },
} satisfies WorkerHandler<typeof fulfillment>;
```

Two Workers cannot bind namespaces hosted by each other in a cycle, though a host Worker can hold a service binding to a guest Worker.

## SQLite storage

Every `$durableObject` namespace uses SQLite storage (`this.ctx.storage.sql`) alongside the key-value storage API (`get`, `put`, `delete`, `list`). Notation diffs desired namespaces against the host Worker's deployed state and generates Cloudflare storage migrations automatically with no numbered migration tags.

## Class renames

Rename a Durable Object class without losing stored objects by keeping `id` unchanged, updating the class name and its named export on the hosting Worker, and deploying:

::code-group

```ts [runtime/order-coordinator.ts]
import { DurableObject } from "cloudflare:workers";
import { $durableObject } from "@notation/cloudflare/workers";

export class OrderWorkflow extends DurableObject {
  async getItems(): Promise<Record<string, number>> {
    return Object.fromEntries(await this.ctx.storage.list<number>());
  }
}

export const orderCoordinator = $durableObject({
  id: "order-coordinator",
  class: OrderWorkflow,
});
```

```ts [runtime/api.ts]
import { $worker } from "@notation/cloudflare/workers";
import { orderCoordinator } from "./order-coordinator";

export { OrderWorkflow } from "./order-coordinator";

export const api = $worker({
  id: "api",
  compatibilityDate: "2026-10-12",
  bindings: () => ({ ORDER_COORDINATOR: orderCoordinator }),
});
```

::

To reuse the previous class name (`OrderCoordinator`) for a different `id`, deploy the rename or removal first, then add the new namespace in a subsequent deploy.

## Deletion protection

By default (`protect: true`), `plan` and `deploy` block dropping a namespace, changing its `id`, or deleting or replacing its host Worker. To remove a namespace intentionally during a `deploy`:

1. Set `protect: false` while the Worker still hosts the namespace, then run `notation deploy`:

```ts [runtime/order-coordinator.ts]
import { DurableObject } from "cloudflare:workers";
import { $durableObject } from "@notation/cloudflare/workers";

export class OrderCoordinator extends DurableObject {}

export const orderCoordinator = $durableObject({
  id: "order-coordinator",
  class: OrderCoordinator,
  protect: false,
});
```

2. Remove the binding and class export (or Worker), then run `notation plan` and `notation deploy`:

```sh [Terminal]
notation plan
notation deploy
```

`notation destroy` tears down the entire stage without running per-resource protection checks (see [`notation destroy`](../../cli/destroy.md)).

## Host transfers

Move a live Durable Object namespace and all stored objects to another existing Worker by moving the named class export while keeping `$durableObject` bound on the previous host:

::code-group

```ts [runtime/api.ts (old host)]
import { $worker } from "@notation/cloudflare/workers";
import { orderCoordinator } from "./order-coordinator";

export const api = $worker({
  id: "api",
  compatibilityDate: "2026-10-12",
  bindings: () => ({ ORDER_COORDINATOR: orderCoordinator }),
});
```

```ts [runtime/fulfillment.ts (new host)]
import { $worker } from "@notation/cloudflare/workers";
import { orderCoordinator } from "./order-coordinator";

export { OrderCoordinator } from "./order-coordinator";

export const fulfillment = $worker({
  id: "fulfillment",
  compatibilityDate: "2026-10-12",
  bindings: () => ({ ORDER_COORDINATOR: orderCoordinator }),
});
```

::

Notation detects that a bound Worker previously hosted the class and runs Cloudflare's transfer sequence automatically.

## Attached containers

Attach a `container` configuration to `$durableObject` to run a Linux container per object instance via `this.ctx.container` (see [Containers](./containers.md)):

```ts [runtime/order-sandbox.ts]
import { DurableObject } from "cloudflare:workers";
import { $durableObject } from "@notation/cloudflare/workers";

export class OrderSandbox extends DurableObject {
  async fetch(request: Request) {
    const container = this.ctx.container;
    if (!container?.running) container?.start();
    return await container!.getTcpPort(8080).fetch(request);
  }
}

export const orderSandbox = $durableObject({
  id: "order-sandbox",
  class: OrderSandbox,
  container: {
    image: { context: "containers/order-sandbox", buildArgs: { NODE_ENV: "production" } },
    maxInstances: 4,
    instanceType: "basic",
    environmentVariables: { LOG_LEVEL: "info" },
  },
});
```

## Reference

### `$durableObject` options

`$durableObject(config)` is exported from `@notation/cloudflare/workers`:

| Parameter | Description |
| :--- | :--- |
| `id` | Required immutable `string` namespace identifier |
| `class` | Required `DurableObjectClass` reference |
| `protect` | Optional `boolean` guarding against deletion, default `true` |
| `container` | Optional `DurableObjectContainerConfig` running a container per object instance |

`id` accepts `1` to `64` characters matching `[A-Za-z0-9_-]`; keep `id` stable when renaming `class` to preserve stored objects. Pass `class` as a bare identifier such as `OrderCoordinator`, never a member expression like `ns.OrderCoordinator`, and never reference it in infra code.

`protect` reads the host Worker's last deployed state to block deleting the namespace or replacing its host Worker. See [Containers](./containers.md#reference) for `DurableObjectContainerConfig` options.

### Hosting rules

- **Explicit named export** – The hosting Worker must export the class by name (`export { OrderCoordinator }`), not via `export *`.
- **Single host** – Exactly one Worker must both bind the namespace and export its class.
- **One namespace per class** – A single Worker cannot host two `$durableObject` IDs backed by the same class name.
- **Bundled Workers** – Infra `worker()` resources can also bind or host a `$durableObject`; they host any bound namespace whose class the file or `"workerd"` bundle exports by name (see [Cloudflare Workers](./workers.md)).
- **`workerd`-safe exports** – Hosting `$worker` modules cannot export primitive constants or `export * as ns` namespace objects.

### Typed stubs

- **RPC stubs** – Classes extending `DurableObject` type `env.<BINDING>` as `DurableObjectNamespace<InstanceType<C>>` inside `WorkerHandler` and `WorkerEnv`.
- **Untyped fallback** – Other classes fall back to `DurableObjectNamespace`.
- **External bindings** – Bindings attached with `addBindings()` are excluded from `WorkerEnv<typeof worker>`.

### Transfer constraints

- **Existing target Worker** – Deploy the destination Worker first without the namespace, then move the class export in a later deploy.
- **No simultaneous rename** – Transfer the namespace first, then rename `class` in a separate deploy.
- **No concurrent target mutations** – Do not rename or delete another namespace on the target Worker during a transfer.
- **SQLite-only source Worker** – Transfers abort if the source Worker hosts any legacy non-SQLite namespace in Cloudflare.
- **Retained old host** – Keep the namespace bound on the previous host during transfer without deleting or replacing a protected old host; untracked source scripts abort to prevent data loss.
