# Bundles SDK

`@notation/build/resources` and `@notation/std/resources` expose deterministic artifact resources (`Bundle`, `std.fs.File`, and `std.fs.Zip`) that implement the shared `{ filePath, fileSha256 }` output contract for compute targets such as AWS Lambda and Cloudflare Workers. See [Bundles](../authoring/bundles.md) for usage examples.

## Bundle constructor

Declare compiled ESM bundles with `bundle(options)` from `@notation/build/resources`.

### `bundle`

`bundle(options)` is a `@resource`-marked factory returning a `Bundle` resource (`type: "build/bundle/Bundle"`, `provider: "@notation/build/resources"`) keyed in state as `bundle:<id>`:

```ts [@notation/build/resources]
/** @resource */
export function bundle(options: BundleOptions): Bundle;
```

`Bundle` writes artifacts under `dist/.bundles/<id>/` (`index.zip` for `"node"`, `index.mjs` for `"workerd"`) and exposes `output: { filePath: string; fileSha256: string }` matching `std.fs.File` (see [Bundle Cache](../internals/bundle-cache.md)).

### `BundleOptions`

`BundleOptions` configures the bundle identifier, target platform, entrypoint, and optional virtual modules:

```ts [@notation/build/resources]
export type PlatformName = "node" | "workerd";

export type BundleOptions = {
  id: string;
  platform: PlatformName;
  entry: string;
  modules?: Record<string, string>;
};
```

Each option enforces synchronous validation when `bundle()` runs:

| Option | Description |
| :--- | :--- |
| `id` | Identifier matching `/^[A-Za-z0-9_-]{1,64}$/` |
| `platform` | Selects `"node"` or `"workerd"` target resolution and packaging |
| `entry` | Key in `modules`, path relative to the project root, or absolute path |
| `modules` | Optional map of virtual module sources keyed by bare specifier |

Disk `entry` paths are read immediately and normalized relative to the project root. Virtual module keys in `modules` cannot start with `"."` or `"/"`, and all values must be strings.

### `BundleConfig`

`Bundle` persists `Id`, `Entry`, and `Platform` in `config` (`BundleConfig`) without `OutputRef` or `Derived` tokens, while deriving `FilePath` and `FileSha256` (`BundleParams`):

```ts [@notation/build/resources]
export type BundleParams = {
  Id: string;
  Entry: string;
  Platform: PlatformName;
  FilePath: string;
  FileSha256: string;
};

export type BundleConfig = Pick<BundleParams, "Id" | "Entry" | "Platform">;
```

### `BundleLike`

`BundleLike` defines the structural interface consumed by compute resources such as `lambda()` and `worker()`:

```ts [@notation/build/resources]
export type BundleLike = BaseResource & {
  readonly config: { Entry: string; Platform: PlatformName };
  readonly output: { filePath: string; fileSha256: string };
  readonly exports: BundleExports;
};
```

### `isBundle`

`isBundle(value)` narrows an unknown value to `BundleLike` by checking `value?.type === "build/bundle/Bundle"` rather than `instanceof`, ensuring bundles remain compatible across multiple installed copies of `@notation/build`:

```ts [@notation/build/resources]
export const isBundle = (value: unknown): value is BundleLike =>
  (value as { type?: unknown } | null)?.type === "build/bundle/Bundle";
```

## Export analysis

When `bundle()` is called, it parses the entry source synchronously to populate `bundle.exports` and verify platform export rules.

### `BundleExports`

`BundleExports` records sorted value exports and `export * from` re-exports found in the entry module:

```ts [@notation/build/resources]
export type BundleExports = {
  names: string[];
  stars: string[];
};
```

`names` includes `"default"` and named re-exports while excluding type-only declarations and `import type` / `export type` bindings. `stars` records the module specifiers of `export * from "..."` statements.

### AST constraints

Static export analysis and bundling enforce two invariants:

- **`workerd` export restrictions** – On `"workerd"`, `bundle()` immediately rejects any non-`default` `const` export initialized with a primitive literal, template literal, unary/binary expression, or `undefined`, as well as namespace re-exports (`export * as ns from "..."`), because `workerd` requires exported functions, classes, or objects.
- **Bundled output parity** – At build time, `Bundle` fails if compilation emits more than one chunk or drops any export listed in `bundle.exports.names`.

## Extension resolution

Virtual `modules` specifiers resolve before platform built-in plugins (so a virtual module can shadow or supply bare specifiers) and select their parser language from the specifier suffix:

| Language | Specifier rule |
| :--- | :--- |
| `"tsx"` | Matches `/\.[cm]?tsx$/` |
| `"ts"` | Matches `/\.[cm]?ts$/` |
| `"jsx"` | Ends with `.jsx` |
| `"js"` | Any other suffix or extensionless specifier |

Extensionless specifiers such as `"virtual:routes"` as well as `.js`, `.mjs`, and `.cjs` files resolve to `"js"`. Both disk entry files (`readEntryExports`) and virtual `modules` use the same extension mapping.

## Platform boundary checks

Each `PlatformName` configures Rolldown resolution, built-in handling, and output packaging identically to colocated declarations (see [Transforms](../internals/transforms.md)).

### Node targets

`platform: "node"` builds a single ESM module with `platform: "node"` and export conditions `["notation-runtime", "node", "import", "default"]`, packaged deterministically into `dist/.bundles/<id>/index.zip` containing `index.mjs`.

### Workerd targets

`platform: "workerd"` builds a single ESM module (`dist/.bundles/<id>/index.mjs`) with `platform: "neutral"`, export conditions `["notation-runtime", "workerd", "worker", "browser", "import", "default"]`, and `mainFields: ["browser", "module", "main"]`. It keeps `cloudflare:*` imports external, defines `process.env.NODE_ENV` (defaulting to `"production"`), and adapts Node built-ins (`node:*` and bare built-in names) to external `node:*` imports.

### Runtime safety checks

During bundle generation, `@notation/build` enforces two boundary checks across all rendered modules:

- **Infra boundary protection** – Fails if the compiled bundle renders any `files.infra` project module or any `@resource` or `@declaration` function from packages. Constants are not inlined across modules (`inlineConst: false`) so accidental infra imports cannot slip past dead-code elimination.
- **Declaration output protection** – Fails if the bundle statically reads a property listed in a `@declaration` mark's `outputs:` clause (such as `api.url` on `$worker`), requiring deploy-time outputs to pass through `env` or `bindings` instead.

## File artifacts

`@notation/std/resources` tracks prebuilt files and packages standalone files into deterministic archives using the same `{ filePath, fileSha256 }` output contract.

### `std.fs.File`

`std.fs.File` (`type: "std/fs/File"`, `provider: "@notation/std/resources"`) tracks an existing file at `config.filePath` without creating, modifying, or deleting it on disk:

```ts [@notation/std/resources]
export type FileSchema = {
  Key: { filePath: string };
  CreateParams: { filePath: string; sourceSha256: string };
  UpdateParams: { filePath: string; sourceSha256: string };
  ReadResult: { fileSha256: string };
};
```

`filePath` is `primaryKey: true`. `deriveParams` computes `sourceSha256` (hex SHA-256 of the file at `filePath`), while `read` computes base64 `fileSha256` and throws `ResourceNotFoundError` when the file is missing (`ENOENT`). `create`, `update`, and `delete` are no-ops.

### `std.fs.Zip`

`std.fs.Zip` (`type: "std/fs/Zip"`, `provider: "@notation/std/resources"`) packages `config.sourceFilePath` into a reproducible single-entry archive at `${sourceFilePath}.zip`:

```ts [@notation/std/resources]
export type ZipSchema = {
  Key: { sourceFilePath: string };
  CreateParams: {
    sourceFilePath: string;
    filePath: string;
    sourceSha256: string;
  };
  UpdateParams: {
    sourceFilePath: string;
    filePath: string;
    sourceSha256: string;
  };
  ReadResult: { fileSha256: string };
};
```

`sourceFilePath` is `primaryKey: true` and `filePath` is `secondaryKey: true`. `deriveParams` computes `sourceSha256` (hex SHA-256 of `sourceFilePath`) and `filePath` (`${sourceFilePath}.zip`). `create` and `update` write a deterministic zip archive, `read` returns base64 `fileSha256` of `filePath` (throwing `ResourceNotFoundError` on `ENOENT`), and `delete` unlinks `filePath` (ignoring `ENOENT`).
