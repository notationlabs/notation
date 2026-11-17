# Bundle Cache

The `Bundle` resource (`build/bundle/Bundle`) compiles standalone Node or Cloudflare Worker artifacts with Rolldown during planning and deployment. It caches build inputs on disk and deduplicates in-flight builds in memory so unchanged bundles skip recompilation. This subsystem spans `packages/build/src/resources/bundle.ts` and `packages/build/src/bundle/{compile,cache,inputs}.ts`.

## The Bundle resource

`bundle(options)` (`@notation/build/resources`) constructs a `Bundle` resource (`type: "build/bundle/Bundle"`, provider `"@notation/build/resources"`) keyed as `bundle:<id>`. Consumers such as `lambda()` and `worker()` validate inputs with `isBundle(value)`. It checks `value?.type === "build/bundle/Bundle"` against `BundleLike` rather than `instanceof`, keeping bundles compatible across multiple workspace copies.

### Construction validation

When `bundle(options)` runs during infra evaluation, it validates inputs synchronously before registering the resource:

| Option | Rule |
| :--- | :--- |
| `id` | Must match `/^[A-Za-z0-9_-]{1,64}$/` |
| `platform` | Must be `"node"` or `"workerd"` via `isPlatformName` |
| `modules` | Optional string map whose keys cannot start with `"."` or `"/"` |
| `entry` | Resolved synchronously via `readEntry` from `modules[entry]` or disk |
| `exports` | Populated synchronously via `readEntryExports` |

For disk entries, `readEntry` resolves `path.resolve(projectRoot(), entry)` and normalizes the relative path while preserving symlinks unless the path lies only under `realRoot(root)`. `readEntryExports(file, source, platform)` records `{ names, stars }` and runs `workerd.checkExports` at evaluation time.

### Schema parameters

`bundleSchema` defines the persisted state fields and computed outputs for `Bundle`:

| Field | Purpose |
| :--- | :--- |
| `Id` | Primary key mapping outputs to `dist/.bundles/<id>/` |
| `FilePath` | Secondary key holding the root-relative artifact path |
| `Entry` | Normalized entry specifier or path |
| `Platform` | Target runtime platform, `"node"` or `"workerd"` |
| `FileSha256` | Base64 SHA-256 digest of the final artifact |
| `filePath` | Computed output exposing the artifact path |
| `fileSha256` | Computed output exposing the artifact digest |

`FilePath` resolves to `dist/.bundles/<id>/index.zip` on `"node"` or `dist/.bundles/<id>/index.mjs` on `"workerd"`. The computed `filePath` and `fileSha256` outputs match the `std.fs.File` contract.

### Lifecycle operations

`Bundle` integrates compilation and verification into standard reconciler lifecycle methods:

- **`deriveParams`** – Computes `key = await bundleKey(source)`, checks `currentFileSha256(id, key, root, FilePath)`, and falls back to `(await cachedBuild(id, source, key)).fileSha256` on a cache miss.
- **`create` / `update` (`#write`)** – Skips disk writes when `currentFileSha256` already matches `params.FileSha256`. On a miss, awaits `cachedBuild`, aborts if `built.fileSha256 !== params.FileSha256` (protecting resumed or post-plan deploys against modified inputs or non-determinism), writes `index.mjs` (plus `index.zip` on `"node"`), and calls `recordInputs`.
- **`read`** – Reads `FilePath` on disk and returns its current base64 SHA-256 (throwing `ResourceNotFoundError` on `ENOENT`). Drift detection can then repair missing or cross-stage overwritten outputs.
- **`delete`** – Recursively removes `dist/.bundles/<id>/`.

## In-memory compilation

`buildBundle(source)` (`packages/build/src/bundle/compile.ts`) runs Rolldown entirely in memory via `build.generate(output)` rather than writing directly to `dist/` during `deriveParams`.

### Virtual module resolution

`buildBundle` configures Rolldown with `functionBuildOptions(platform, root)`. It mounts `bundlePlugin` *before* `input.plugins` so entries in `modules` override platform plugins (such as `nodeBuiltinsPlugin` for Node built-in names):

- Specifiers present in `modules` resolve to `\0notation-bundle:<specifier>`, mapped by extension to `"tsx"` (`/\.[cm]?tsx$/`), `"ts"` (`/\.[cm]?ts$/`), `"jsx"` (`.jsx`), or `"js"`.
- `bundlePlugin.buildEnd` captures `[...this.getModuleIds()]` for input hashing.
- `bundlePlugin.generateBundle` enforces `checkRenderedInfra` and `findOutputRead` (see [Transforms](./transforms.md)).

`buildBundle` rejects any build that emits more than one chunk (`chunks.length !== 1`) or drops any export name recorded in `source.exports`.

### Deterministic zip packaging

When `platform === "node"`, `buildBundle` packages `chunk.code` into a reproducible single-entry zip archive using `fflate`:

```ts [packages/build/src/bundle/compile.ts]
const file =
  platform === "node"
    ? zipSync(
        { [moduleFileName]: new TextEncoder().encode(code) },
        { level: 9, mtime: "0/0/00 00:00 PM" },
      )
    : new TextEncoder().encode(code);
```

Pinning `level: 9` and `mtime: "0/0/00 00:00 PM"` (matching `std.fs.Zip`) guarantees identical `fileSha256` digests for unchanged compiled bytes. On `"workerd"`, `file` holds the UTF-8 bytes of `index.mjs` directly.

## Cache keys

`bundleKey(source)` (`packages/build/src/bundle/cache.ts`) hashes all non-file inputs that affect the build output or boundary checks into a hex SHA-256 digest:

| Input | Source |
| :--- | :--- |
| `entry` | Normalized entry specifier or path |
| `platform` | Target platform name |
| `modules` | Virtual module map sorted lexicographically by specifier |
| `input` | Resolved Rolldown input options from `functionBuildOptions` |
| `output` | Resolved Rolldown output options from `functionBuildOptions` |
| `globs` | Project `files` globs from `projectGlobs()` |
| `build` | Version from `@notation/build` `package.json` |
| `rolldown` | Rolldown `VERSION` string |

When serializing `input` and `output`, `bundleKey` encodes `RegExp` values with `.toString()` and plugin or hook functions as `` `function ${item.name}` ``.

## Transitive input collection

`collectInputs(moduleIds, root)` (`packages/build/src/bundle/inputs.ts`) records the hex SHA-256 hash of every on-disk file that influenced compilation or module resolution, keyed by sorted POSIX path relative to `root`.

### Module config traversal

Virtual module IDs (`id.startsWith("\0")`) and non-absolute specifiers are skipped. For every real module ID reported by Rolldown, `collectInputs` adds:

1. **The module file itself**.
2. **Nearest `package.json`** – Walking upward from `path.dirname(id)` via `nearestFile`.
3. **Nearest `tsconfig.json` and transitive graph (`addTsconfig`)** – Parses each `tsconfig.json` as a parenthesized JavaScript expression with `parseSync` (tolerating JSONC comments and trailing commas) and recursively follows:
   - **`extends`** (string or array of strings), resolved relative to the config directory or via `createRequire` with `.json` and `/tsconfig.json` fallbacks.
   - **`references`** (`path` objects), resolving directories to `<dir>/tsconfig.json`.

### Lockfile discovery

After scanning all module IDs, `collectInputs` walks upward from `root` to find the first directory with a lockfile. It adds every lockfile present from: `pnpm-lock.yaml`, `package-lock.json`, `npm-shrinkwrap.json`, `yarn.lock`, `bun.lock`, and `bun.lockb`.

## On-disk manifest

Each settled build persists its cache manifest to `dist/.bundles/<id>/inputs.json`:

```ts [packages/build/src/bundle/cache.ts]
export type BundleInputs = {
  key: string;
  files: Record<string, string>;
  fileSha256: string;
};
```

### Atomic writes

Concurrent `plan` and `deploy` processes can target the same bundle directory, so `writeInputs` writes to `${file}.${process.pid}.${crypto.randomUUID()}.tmp` and renames atomically to `inputs.json`.

### Settled timestamp guard

If an input file changes while `buildBundle` runs, `collectInputs` could hash newer bytes than Rolldown read. `buildBundle` captures `started = Date.now()` before Rolldown starts and computes `settled: !modifiedSince(files, root, started)`:

```ts [packages/build/src/bundle/inputs.ts]
const mtimeSlackMs = 1000;

export function modifiedSince(
  files: Record<string, string>,
  root: string,
  started: number,
): boolean {
  const stats = Object.keys(files).map((file) =>
    fs.statSync(path.resolve(root, file), { throwIfNoEntry: false }),
  );
  const finished = Date.now();
  return stats.some(
    (stat) =>
      !stat ||
      (stat.mtimeMs >= started - mtimeSlackMs &&
        stat.mtimeMs <= finished + mtimeSlackMs),
  );
}
```

The `mtimeSlackMs = 1000` margin accounts for 1-second filesystem timestamp granularity and minor clock skew, while ignoring files with `mtimeMs > finished + mtimeSlackMs`. When `settled` is `false`, `recordInputs` skips writing `inputs.json` so the next plan performs a clean rebuild.

### Cache hit verification

`currentFileSha256(id, key, root, filePath)` returns `inputs.fileSha256` without running Rolldown only when all three checks pass:

1. `inputs.json` exists, parses cleanly, and matches `inputs.key === key`.
2. `sameFiles(inputs.files, root)` confirms every recorded file on disk still matches its hex SHA-256 hash.
3. The artifact at `path.resolve(projectRoot(), filePath)` exists on disk and hashes to `inputs.fileSha256`.

### Watch input discovery

`bundleInputFiles(root)` reads every `dist/.bundles/*/inputs.json` manifest and returns sorted resolved paths. `notation watch` uses this list to watch bundle dependencies (including workspace packages) not directly imported by the infra entry.

## In-process build deduplication

`cachedBuild(id, source, key)` (`packages/build/src/bundle/cache.ts`) maintains an in-process `builds` map (`Map<string, BuildCache>`) keyed by `id`:

- If `builds.get(id)` has `cached.key === key` and either `!cached.files` (still in flight) or `sameFiles(cached.files, source.root)`, `cachedBuild` returns the existing `cached.built` promise.
- Otherwise it starts `buildBundle(source)`, stores `entry.files`, and calls `recordInputs` upon completion. A `.catch` handler removes `entry` from `builds` if `builds.get(id) === entry` so failed builds can retry cleanly.
