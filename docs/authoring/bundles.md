# Bundles

Use `@notation/build/resources` to compile Node and Cloudflare Worker bundles deterministically at deploy time, or `@notation/std/resources` to track prebuilt files and archives. Both packages expose the same `{ filePath, fileSha256 }` output contract so custom compute resources can accept either seamlessly.

Install both packages when authoring custom resources or helpers that build or consume deployment artifacts:

```sh [Terminal]
@pm.add("@notation/build")
@pm.add("@notation/std")
```

## Compiling bundles

`bundle(options)` compiles a single-file ESM bundle during `plan` and `deploy` using the same Rolldown target configuration, `"notation-runtime"` condition, and boundary checks as [`$lambda`](../providers/aws/lambda.md) and [`$worker`](../providers/cloudflare/workers.md).

Pass a bundle as `code` to AWS `lambda()` for Node handlers or Cloudflare `worker()` for `workerd` scripts, optionally generating virtual modules:

::code-group

```ts [AWS: infra/orders.ts]
import { bundle } from "@notation/build/resources";
import { lambda } from "@notation/aws/lambda";

const orderBundle = bundle({
  id: "create-order",
  platform: "node",
  entry: "src/orders/create-order.ts",
  modules: {
    "virtual:order-config": `export default ${JSON.stringify({ currency: "USD" })};`,
  },
});

export const createOrder = lambda({
  id: "create-order",
  code: orderBundle,
  handler: "handler",
});
```

```ts [Cloudflare: infra/api.ts]
import { bundle } from "@notation/build/resources";
import { worker } from "@notation/cloudflare/workers";

const apiBundle = bundle({
  id: "orders-api",
  platform: "workerd",
  entry: "virtual:main.ts",
  modules: {
    "virtual:main.ts": `import routes from "virtual:routes"; export default { fetch() { return Response.json(routes); } };`,
    "virtual:routes": `export default ["/orders", "/webhooks/orders"];`,
  },
});

export const api = worker({
  id: "orders-api",
  code: apiBundle,
  compatibilityDate: "2026-10-12",
});
```

::

Keep three constraints in mind when calling `bundle()`:

- **Keep `id` stable** – `bundle()` keys the resource in state as `bundle:<id>`, so changing `id` replaces the bundle instead of updating it.
- **Use bare specifiers in `modules`** – Virtual module keys cannot start with `"."` or `"/"` and compile according to their extension (`.ts`, `.tsx`, `.jsx`, or JS).
- **Avoid unsupported `"workerd"` exports** – `bundle()` parses entry exports synchronously and rejects non-`default` primitive `const` exports and `export * as ns` on `"workerd"` immediately.

`Bundle` caches compilation results across `plan` and `deploy` using content hashes of transitive inputs and detects modified artifacts on disk during drift checks.

## Prebuilt artifacts

When code is compiled externally or targets another runtime such as Python, track an existing archive with `std.fs.File` or package a standalone file into a deterministic `.zip` with `std.fs.Zip`:

::code-group

```ts [Prebuilt zip: fs.File]
import * as std from "@notation/std/resources";

export const artifact = new std.fs.File("create-order:zip", {
  config: { filePath: "external/create-order.zip" },
});
```

```ts [Single file: fs.Zip]
import * as std from "@notation/std/resources";

export const artifact = new std.fs.Zip("create-order:zip", {
  config: { sourceFilePath: "external/create-order.mjs" },
});
```

::

`std.fs.File` hashes an existing archive in place without modifying or deleting it, whereas `std.fs.Zip` builds and cleans up `${sourceFilePath}.zip`. Both expose `filePath` and base64 `fileSha256` outputs matching `Bundle`.

## Consuming artifacts

A custom resource can accept `BundleLike`, `std.fs.FileInstance`, and `std.fs.ZipFileInstance` through a single dependency union in `.requireDependencies()` and verify the local file's SHA-256 hash before uploading bytes:

```ts [infra/resources/webhook-handler.ts]
import crypto from "node:crypto";
import * as nodeFs from "node:fs/promises";
import * as v from "valibot";
import { fromProjectRoot } from "@notation/core/paths";
import { resource } from "@notation/resource";
import type { BundleLike } from "@notation/build/resources";
import type { fs as stdFs } from "@notation/std/resources";

export type WebhookHandlerDeps = { code: stdFs.FileInstance | stdFs.ZipFileInstance | BundleLike };

async function readVerifiedCode(filePath: string, expectedSha256: string) {
  const bytes = await nodeFs.readFile(fromProjectRoot(filePath));
  const actual = crypto.createHash("sha256").update(bytes).digest("base64");
  if (actual !== expectedSha256) {
    throw new Error(`Artifact ${filePath} changed after plan (${actual} !== ${expectedSha256}).`);
  }
  return bytes;
}

export const WebhookHandler = resource({ type: "custom/webhooks/WebhookHandler", provider: "@acme/webhooks" })
  .defineSchema({
    Name: { propertyType: "param", presence: "required", immutable: true, primaryKey: true, value: v.string() },
    CodeFilePath: { propertyType: "param", presence: "required", hidden: true, value: v.string() },
    CodeSha256: { propertyType: "param", presence: "required", value: v.string() },
  } as const)
  .defineOperations({
    create: async (params) => uploadHandler(params.Name, await readVerifiedCode(params.CodeFilePath, params.CodeSha256)),
    read: async (key) => ({ Name: key.Name, CodeSha256: await fetchRemoteSha256(key.Name) }),
    update: async (key, _patch, params) => uploadHandler(key.Name, await readVerifiedCode(params.CodeFilePath, params.CodeSha256)),
    delete: async (key) => deleteHandler(key.Name),
  })
  .requireDependencies<WebhookHandlerDeps>()
  .deriveParams(({ deps }) => ({ CodeFilePath: deps.code.output.filePath, CodeSha256: deps.code.output.fileSha256 }));
```

Marking `CodeFilePath` with `hidden: true` keeps local build paths out of state and diffing when the remote API only returns the deployed `CodeSha256`. Verifying `expectedSha256` before uploading guarantees resumed deploys never send stale or edited files.

## Group helpers

When building a `ResourceGroup` wrapper around `WebhookHandler` (mirroring `lambda()` and `worker()`), check incoming `code` values with `isBundle()` instead of `instanceof Bundle` so bundles from other installed copies of `@notation/build` match:

```ts [infra/resources/order-function-group.ts]
import { isBundle, type BundleLike } from "@notation/build/resources";
import { ResourceGroup } from "@notation/resource";
import * as std from "@notation/std/resources";

export type FunctionCodeInput = { type: "file" | "zip"; path: string } | BundleLike;

export class OrderFunctionGroup extends ResourceGroup {
  readonly code: std.fs.FileInstance | std.fs.ZipFileInstance | BundleLike;

  constructor(id: string, code: FunctionCodeInput) {
    super("OrderFunction", id);

    if (isBundle(code)) {
      if (code.config.Platform !== "node") {
        throw new Error(`OrderFunction "${id}" requires a "node" bundle, got "${code.config.Platform}".`);
      }
      this.code = code;
    } else if (code.type === "file") {
      this.code = this.add(new std.fs.Zip(`order-fn:${id}:zip`, { config: { sourceFilePath: code.path } }));
    } else {
      this.code = this.add(new std.fs.File(`order-fn:${id}:file`, { config: { filePath: code.path } }));
    }
  }
}
```

Follow two conventions in group wrappers:

- **Do not call `this.add(code)` on external bundles** – Store `this.code = code` and pass it via `dependencies` because `bundle()` already registers itself in the active resource graph.
- **Validate named exports upfront** – When your runtime invokes a named export, check `code.exports.names` during evaluation (skipping when `code.exports.stars.length > 0` or `code.exports.names.length === 0` for CommonJS).
