# Transforms

`@notation/build` compiles one TypeScript codebase into a Node deployment bundle and per-function ESM bundles. It synthesizes virtual entries, rewrites ASTs with `MagicString`, and enforces platform and boundary invariants in Rolldown hooks. This transformation layer spans `infra-entry.ts`, `infra-strip.ts`, `runtime-strip.ts`, `plugins.ts`, `platforms.ts`, `output-reads.ts`, and `options.ts` in `packages/build/src/`.

## Infra entry synthesis

`infraEntryPlugin` (`packages/build/src/infra-entry.ts`) replaces the configured entry with a synthetic virtual module (`infraEntry = "notation:infra-entry"`, resolved to `"\0notation:infra-entry"`). Standalone runtime declaration files then execute at deploy time even when `infra/` never imports them.

### Root discovery

In `load`, `infraEntryPlugin` calls `files.checkOverlaps()`, collects `infraRoots(analyses, entryPoint)` (`[entryPoint, ...runtimeWithDeclaration]`), and emits static imports in order:

```ts [notation:infra-entry]
import "/project/infra/index.ts";
import "/project/runtime/nightly-report.ts";
import "/project/runtime/todos.ts";
```

Because ES modules execute once per module graph, a declaration module imported by `entryPoint` runs once. Runtime files without a `@declaration` (such as side-effect setup modules) are excluded, and any `files.runtime` file failing static analysis aborts the build during `infraRoots`.

### Watch roots

In watch mode (`this.meta.watchMode`), `globBases` extracts the static prefix before the first glob character of each `files.runtime` pattern. It walks up to `files.root` if that directory does not exist yet and registers each directory with `this.addWatchFile`.

Pair `infraEntryPlugin` with `watch: { exclude: infraWatchExclude }` (`**/dist/**`, `**/node_modules/**`, `**/.*/**`). Generated artifacts and `.notation/` state writes then never trigger rebuild loops.

## Infra build plugin

`infraPlugin` (`packages/build/src/plugins.ts`) strips runtime handler code from project modules, prevents platform-only imports from executing in Node, and collects `DeclarationModule[]` metadata for the runtime pass.

### External resolution

`infraPlugin.resolveId` handles two external categories:

- **Platform-provided modules** – Specifiers matching `providerOfModule(source)` (such as `cloudflare:*`) resolve to `{ id: source, external: true, moduleSideEffects: false }`. Unused imports in stripped runtime modules then tree-shake cleanly.
- **Installed packages** – Bare specifiers matching `isInstalledPackage(source, importer, installed)` resolve to `{ id: source, external: true }` by walking upward for `node_modules/<pkg>`. Results cache per build and clear in `buildStart`, while `tsconfig.json` path aliases remain bundled.

### Declaration stripping

For project modules matching `files.runtime` or `mayHoldMarks` (`/\bimport\b|\bfrom\b|@declaration|@resource/`), `infraPlugin.transform` runs `checkDeclaration` and `checkRuntimeImports`. Declaration modules are then transformed with `stripForInfra` (`packages/build/src/infra-strip.ts`):

1. **Preconditions** – Verifies `declaration.mark.entry` is exported via `marks.hasExport`. Rejects modules defining reserved names `__notation_declaredIn` or `__notation_unnamed`.
2. **Statement reachability (`keptStatements`)** – Walks `freeReferences` from `declaration.statement` (skipping `mark.runtime` properties) to keep transitive local declarations (`owners`) and used import specifiers (`keptImport`), splitting mixed namespace/named imports onto separate lines. Preserves `isTypeOnly` statements while stripping handlers, SDK clients, and side-effect imports.
3. **Runtime option stubs** – Calls `replaceRuntimeOptions` for every property listed in `mark.runtime`.
4. **Module identity wrapper** – Wraps `declaration.call` in `__notation_declaredIn(<call>, <relativePath>, <binding>, <moduleExports?>)` using an inline copy of `declaredInSource` (`Symbol.for("@notation/declaredIn")`). Appends `{ exports, starExports }` when `otherExports(analysis)` is present (`workerd`) and validates exports via `platformOf(platform).checkExports`.

`stripForInfra` writes paths relative to `files.root` so infra bundles stay machine-independent.

### Runtime option stubs

`replaceRuntimeOptions` replaces each property listed in `mark.runtime` (such as `class` on `$durableObject` or `entrypoint` on `$worker`) with a function that throws if called at deploy time:

- **Declared or imported non-method `Identifier`** – `class: Counter` becomes `class: function Counter() { throw new Error(...); }`, preserving `config.class.name === "Counter"`.
- **Any other expression** – Calls the inline `__notation_unnamed(message)` helper returning an arrow function whose `.name` is `""`. This avoids Rolldown's tendency to infer the object property key as the function name for inline arrows.

### Cross-module interface checks

`checkRuntimeImports` verifies that every named import (outside dropped statements in declaration modules) and every `export { x } from` targeting a declaration module resolves to an export in `infraInterface(target).exports`. Without this check, Rolldown emits a generic missing-export error instead of explaining that runtime-only exports are stripped from deploy builds.

In `generateBundle`, `infraPlugin` runs `keptStaticImport` over each emitted chunk's AST because `chunk.imports` retains tree-shaken imports. It fails if any static `import` of a `providerOfModule` specifier survived (while permitting dynamic `import()`), then emits the surviving `DeclarationModule[]` list sorted by `path` to `onDeclarationModules`.

### Non-declaration runtime stripping

`RuntimeStrips` (`packages/build/src/infra-strip.ts`) computes a demand-driven fixpoint across the whole infra graph before transforming non-declaration `runtime` modules with `stripRuntimeForInfra`:

1. **Roots** – Starts from `infraRoots(analyses, entryPoint)`.
2. **Whole modules** – Modules without a declaration outside `files.runtime` (`infra`, `shared`, unmatched) run whole. They demand every non-type module import/re-export edge and every non-provided imported binding.
3. **Declaration modules** – Demand only `statementReferences(declaration.statement)` (excluding `mark.runtime` options) and their transitive local statements.
4. **Stripped runtime modules** – Demand only the specific exports requested by kept code (expanding `*` across local exports and `export * from`). Keeps only their owner statements and imports while dropping side-effect imports and unrelated initializers.

If any demanded reference resolves to `providerOfModule(source)` (such as `cloudflare:workers`), `RuntimeStrips.#fail` throws immediately. The error reports the originating deploy-time file, `line:column`, the importing module, and `runtime` option advice.

## Runtime build plugin

`compileRuntimeModules` builds one standalone ESM bundle per `DeclarationModule` that defines `entry`, combining `functionBuildOptions` (`packages/build/src/options.ts`) with `runtimePlugin` (`packages/build/src/plugins.ts`).

### Function build options

Both `compileRuntimeModules` and `bundle()` configure Rolldown through `functionBuildOptions(platform, cwd)`:

```ts [packages/build/src/options.ts]
export function functionBuildOptions(
  platform: PlatformName | undefined,
  cwd: string = realRoot(projectRoot()),
): FunctionBuildOptions {
  return {
    input: {
      cwd,
      tsconfig: true,
      ...platformOf(platform).build(),
      optimization: { inlineConst: false },
    },
    output: { format: "esm", codeSplitting: false },
  };
}
```

Three settings isolate runtime bundles from deploy-time code:

| Option | Purpose |
| :--- | :--- |
| `cwd` | Pins `realRoot` so Rolldown region comments match across symlinks and machines |
| `codeSplitting` | Set to `false` to keep Lambda zips and Worker uploads to a single module |
| `optimization.inlineConst` | Set to `false` so short `infra` primitives do not inline before `checkRenderedInfra` |

### Runtime entry synthesis

`runtimePlugin` resolves `runtimeEntry` (`"notation:runtime-entry"`) to `"\0notation:runtime-entry"`. In `load`, it reads the target module fresh via `analyses.fromDisk(module.path)` and generates re-exports with `createRuntimeEntry`:

- Emits `export { handler } from "/project/runtime/orders.ts";` (or includes `otherExports` when `reexportsModule` is `true`, quoting non-identifier names).
- Excludes the declaration binding itself so unused declarations tree-shake away.
- Emits `"export {};\n"` if `entry` is no longer exported. `generateBundle` deletes all bundle files when the entry chunk has `exports.length === 0`, preventing watch mode from overwriting previous builds with empty bundles.

### Runtime stripping

For declaration modules in `transform`, `stripForRuntime` (`packages/build/src/runtime-strip.ts`) reduces declarations to their runtime surface:

1. **Drop deploy options** – Removes properties not in `keptOptions(mark)` (`shared` + `runtime`), merging overlapping comma ranges via `mergeRanges`.
2. **Rewrite `keys` options** – `returnedObject` verifies each `mark.keys` option is `() => ({ ... })` or a single-return function block (no spreads, computed keys, accessors, or method shorthand). It then overwrites every property value to `undefined`.
3. **Substitute `@resource` arguments** – Replaces infra-imported resources inside kept options via `resourceStub`.
4. **Validate remaining references** – `checkAlias` rejects local `const` aliases pointing to infra resources. `checkReference` rejects remaining free references pointing to `files.infra`, `unmatchedResourceCall` modules, or `@resource` functions.
5. **Prune emptied imports (`removeEmptiedImports`)** – Deletes `ImportDeclaration` statements that had referenced specifiers before stripping and zero remaining uses outside `removed`. Side-effect imports (`import "./sentry"`) stay intact under `verbatimModuleSyntax`.
6. **Mark purity** – Prepends `/*#__PURE__*/ ` before `declaration.call.start`. Unused declarations drop cleanly when another runtime module imports a Durable Object class from the file.

### Resource argument stubbing

When `resourceStub` finds a `memberPath` (`orderQueue` or `queues.orders`) imported from `files.infra` inside a kept option, it traces `importedValue` / `exportedValue` / `localValue` / `followKeys` to a `const` initialized by a `@resource` call:

- **Bare `@resource`** – Left unreplaced so `checkReference` fails with an infra-value error.
- **`@resource runtime:`** – Replaced with `{}`.
- **`@resource runtime: schema` (`runtimeOptions`)** – Verifies the call argument is an object literal so missing options cannot hide behind a `SpreadElement`. Each listed option must be a direct named or default import from a runtime-safe module (not `infra`, `runtime`, or `unmatchedResourceCall`). `resourceStub` injects `import { <imported> as __notation_<option>_<n> } from "<specifier>";` at the top of the file (after any `#!` hashbang, preserving package names or using resolved paths) and rewrites the argument to `{ <option>: __notation_<option>_<n> }`.

Member reads on a resource (`orderQueue.schema`) leave `found.rest > 0` and remain unreplaced, failing as infra values.

### Rendered infra verification

In `generateBundle`, both `runtimePlugin` and `bundlePlugin` call `checkRenderedInfra` on every chunk before minification (`renderedLength > 0`):

- Rejects any rendered `files.infra` module. Lists call sites from `usesOfImports` (ignoring nodes inside the module's own declaration call) and the shortest BFS `importChain` from the entry.
- Rejects any rendered package module whose `renderedExports` contain a `@resource` or `@declaration` export. Appends `analyses.resourceCallAdvice(file)` along the chain if an unmatched file executed a resource constructor at top level.

## Output read guards

Deploy-time outputs listed in a `@declaration` mark's `outputs:` clause (such as `url` on `$worker`) are unknown until deployment, so runtime bundles forbid reading them directly.

### Static detection

`findOutputRead` (`packages/build/src/output-reads.ts`) runs inside `generateBundle` for `runtimePlugin` and `bundlePlugin`:

1. Inspects every project module with `renderedLength > 0`.
2. Skips references inside `strippedOptions(declaration)` (dropped options and `keys` options rewritten to `undefined`), while still checking kept runtime options such as `class` on `$durableObject`.
3. Expands each reference via `outermostMember` into a static `memberPath` (`api.url`, `api["url"]`, or `workers.api.url`).
4. Resolves the root via `localValue` (or `namespaceValue` consuming the first key for namespace imports). Checks whether `unwrap(value.node) === owner.call` and `owner.mark.outputs?.includes(key)`.

On match, `describeOutputRead` formats the error using `owner.mark.name` (for example `$worker({ id: "api" })`). The error labels the bundle `"Worker code"` (`workerd`) or `"function code"` (`node`).

### Uncovered patterns

Because `findOutputRead` operates statically on direct member paths without analyzing `node_modules/`, it misses destructuring (`const { url } = api`), local `const` aliases, declaration values passed to helpers, and computed non-literal keys. Runtime entries of declaration packages backstop this check with throwing non-enumerable getters for each property in `outputs:`.

## Platform profiles

`packages/build/src/platforms.ts` isolates target runtime settings behind `platformOf(name)` (defaulting to `"node"`).

### Node profile

The `node` profile configures `platform: "node"`, `resolve.conditionNames: ["notation-runtime", "node", "import", "default"]`, and `reexportsModule: false`. Only the contract export `entry` is re-exported from `runtimeEntry`.

### Workerd profile

The `workerd` profile configures `platformOf("workerd")` with these settings:

| Setting | Value |
| :--- | :--- |
| `platform` | `"neutral"` |
| `resolve.conditionNames` | `["notation-runtime", "workerd", "worker", "browser", "import", "default"]` |
| `resolve.mainFields` | `["browser", "module", "main"]` |
| `external` | `[/^cloudflare:/]` |
| `reexportsModule` | `true` |
| `provided` | `{ modules: /^cloudflare:/, availableIn: "a Worker" }` |
| `transform.define` | `process.env.NODE_ENV` defaulting to `"production"` |

The `transform.define` map replaces `process.env.NODE_ENV` along with `global.process.env.NODE_ENV` and `globalThis.process.env.NODE_ENV`.

### Export validation

Because `workerd` refuses main modules that export non-function, non-class, non-object values (primitives, `null`, `undefined`, or module namespace objects), `workerd.checkExports` runs during `stripForInfra` and `readEntryExports`:

- Rejects `export * as ns from "..."` namespace re-exports.
- Rejects top-level `const` exports initialized to `isPrimitive` (`Literal` except regex, `TemplateLiteral`, `UnaryExpression`, `BinaryExpression`, or `undefined`).

`let` and `var` exports are left unchecked because modules may assign object values later at runtime.

### Built-in shims

`nodeBuiltinsPlugin` (mounted in `workerd.build().plugins`) intercepts `node:*` and bare `builtinModules` specifiers, even when shadowed by an installed polyfill package:

- **ESM imports** – Maps to `{ id: "node:<name>", external: true }` for `nodejs_compat`.
- **CommonJS `require("...")` (`options.kind === "require-call"`)** – Routes through virtual `\0notation-required-builtin:<name>` shims that re-export `node:<name>`'s default export via `module.exports`.
