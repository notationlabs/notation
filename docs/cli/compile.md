# notation compile

`notation compile` validates module boundaries and builds your infrastructure entrypoint and runtime bundles into `dist/` without running deploy-time code or requiring cloud credentials.

## Usage

Run `notation compile` from your project root to validate and build the project described by `notation.config.ts`:

```sh [Terminal]
@pm.dlx("notation compile")
```

Pass `--config` to target a config file outside the current working directory:

```sh [Terminal]
@pm.dlx("notation compile --config apps/orders/notation.config.ts")
```

Because `notation compile` bundles TypeScript without running `tsc` typechecking, pair it with a `typecheck` script in `package.json`:

```json [package.json]
{
  "scripts": {
    "compile": "notation compile",
    "typecheck": "tsc --noEmit"
  }
}
```

## Options

`notation compile` accepts only `--config <path>` (default: nearest `notation.config.ts`). Because it builds without resolving a stage or evaluating infrastructure code, it does not accept `--stage`, `--json`, or `--pretty` and requires no cloud credentials.

## Boundary validation

Before emitting bundles, `notation compile` enforces Notation's split-compilation rules across `infra`, `runtime`, and `shared` modules – catching misplaced declarations, forbidden cross-layer imports, static reads of declaration outputs in runtime code, and invalid Worker exports before deploy.

## Compilation phases

`notation compile` runs two build passes: first building a deploy-time infrastructure bundle, then compiling each declared function or Worker into an isolated runtime bundle.

Both AWS Lambda and Cloudflare Worker declaration modules go through this two-phase build:

::code-group

```ts [runtime/orders.ts]
import { $lambda, sqs, type LambdaHandler } from "@notation/aws/lambda";
import { orderQueue } from "../infra/orders";

export const lambda = $lambda({
  id: "orders",
  event: () => sqs.bind(orderQueue),
});

export const handler: LambdaHandler<typeof lambda> = async (event) => {
  for (const record of event.Records) await lambda.decode(record);
};
```

```ts [runtime/api.ts]
import { $worker, type WorkerHandler } from "@notation/cloudflare/workers";
import { orderCache } from "../infra/orders";

export const worker = $worker({
  id: "api",
  compatibilityDate: "2026-10-12",
  bindings: () => ({ ORDERS_CACHE: orderCache }),
});

export default {
  async fetch(_req, env) {
    return Response.json(await env.ORDERS_CACHE.get("latest"));
  },
} satisfies WorkerHandler<typeof worker>;
```

::

### Infrastructure bundle

The first pass bundles `entry` and declaration modules into ESM under `dist/`, stripping runtime handlers so deploy never loads runtime SDKs.

### Runtime bundles

The second pass emits one standalone ESM bundle for each declaration with a runtime entry, stripping deploy-only options. Entryless declarations such as `$durableObject` are bundled into the Worker that binds them.

## Generated artifacts

For an `entry` of `infra/orders.ts` with `runtime/orders.ts` (AWS) or `runtime/api.ts` (Cloudflare), `notation compile` writes the following outputs under `dist/`:

```text [dist/]
dist/
├── infra/
│   ├── orders.mjs
│   └── orders.mjs.map
├── chunks/
└── runtime/
    ├── orders/
    │   └── index.mjs
    └── api/
        └── index.mjs
```

`notation compile` writes only compiled bundles and source maps under `dist/` without creating state or deployment caches.

## Skipping compilation

To reuse the `dist/` build emitted by `notation compile` in a separate deploy step, pass `--no-compile` to [`notation deploy`](./deploy.md):

```sh [Terminal]
@pm.dlx("notation compile")
@pm.dlx("notation deploy --stage prod --no-compile")
```

Compilation behavior differs across deploy and preview commands:

| Command | Behavior |
| :--- | :--- |
| `notation deploy --no-compile` | Deploys directly from `dist/` without rebuilding |
| `notation plan` | Always compiles before evaluating changes and has no `--no-compile` flag |
| `notation watch` | Compiles continuously in watch mode and deploys each updated build |
