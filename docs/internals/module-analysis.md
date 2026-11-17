# Module Analysis

`@notation/build` inspects TypeScript and JavaScript source modules statically before bundling. It discovers `@declaration` and `@resource` builders, classifies module kinds, and enforces import boundaries. This pipeline spans `ast.ts`, `marks.ts`, `analyze.ts`, `files.ts`, `modules.ts`, and `exports.ts` in `packages/build/src/`.

## AST utilities

`packages/build/src/ast.ts` provides lightweight parsing and scope-aware AST traversal built on Rolldown's native parser.

### Module parsing

`parseModule(file, source)` maps the file extension (`/\.[cm]?tsx$/` to `"tsx"`, `/\.[cm]?ts$/` to `"ts"`, `.jsx` to `"jsx"`, otherwise `"js"`). It calls `parseSync(file, source, { lang, sourceType: "module" })` from `rolldown/utils`, throws on the first syntax error, and returns `{ file, source, body, comments }`.

`location(source, offset)` computes 1-based `line:column` strings for diagnostics. `unwrap(node)` strips `ParenthesizedExpression` and `typeWrappers` (`TSAsExpression`, `TSSatisfiesExpression`, `TSNonNullExpression`, `TSTypeAssertion`, `TSInstantiationExpression`).

### Free reference collection

`freeReferences(node, skip)` returns every `Reference` (`{ node, ancestors }`) under `node` that refers to an outer binding, skipping any subtree in `skip`:

- **Type erasure** – Skips `typeFields` (`typeAnnotation`, `typeParameters`, `typeArguments`, `returnType`, `superTypeArguments`, `implements`). Also skips `TS*` nodes other than `typeWrappers` and `valueTsNodes` (`TSEnumDeclaration`, `TSEnumBody`, `TSEnumMember`, `TSModuleDeclaration`, `TSModuleBlock`, `TSParameterProperty`, `TSExportAssignment`).
- **Scope shadowing** – Tracks bindings from `functionScope` (parameters, `FunctionExpression` name, non-nested `var` declarations) and `lexicalNames` (`let`, `const`, `class`, and block-scoped `function` declarations in blocks, `switch` cases, and `for` loops). Also tracks `CatchClause` parameters and `ClassExpression` names.
- **Pattern defaults** – Walks default values and computed keys in binding patterns (`ObjectPattern`, `ArrayPattern`, `RestElement`, `AssignmentPattern`, `TSParameterProperty`). Excludes bound identifiers.
- **JSX references** – Includes `JSXIdentifier` tags starting with non-lowercase characters (`<Comp />`, `<ui.Comp />`). Ignores lowercase intrinsic elements (`<div>`) and closing tags.

### JSDoc extraction

`leadingJsDoc(module, start)` scans `module.comments` backwards for the `Block` comment starting with `*` immediately before `start`. The slice `module.source.slice(comment.end, start)` must contain only whitespace.

## JSDoc marks

`packages/build/src/marks.ts` reads `@declaration` and `@resource` JSDoc tags from exported functions in provider packages (`dist/*/index.js`) and local wrapper modules. This avoids per-provider compiler plugins.

`parseMark(jsDoc, { file, provider })` strips leading `*` prefixes from each line. It matches `/(?:^|\s)@(declaration|resource)\b([^\n@]*)/`, stopping at the end of the line or the next `@` tag.

### The declaration mark

A `@declaration` tag produces a `DeclarationMark` from semicolon-separated `clause: value` pairs:

```ts [packages/build/src/marks.ts]
export type DeclarationMark = {
  kind: "declaration";
  shared: string[];
  runtime: string[];
  keys: string[];
  entry?: string;
  entryOption?: string;
  platform?: PlatformName;
  outputs?: string[];
  name?: string;
};
```

Each clause controls compiler behavior across the infra and runtime passes:

| Clause | Purpose |
| :--- | :--- |
| `shared` | Option names kept in both infra and runtime builds |
| `runtime` | Option names kept in runtime and stubbed to throw in infra |
| `keys` | Function options whose returned object values rewrite to `undefined` in runtime |
| `entry` | Export name invoked by the runtime platform |
| `entryOption` | Option whose class identifier must match the `entry` export |
| `platform` | Target runtime profile, defaulting to `"node"` |
| `outputs` | Declaration properties holding deploy-time outputs blocked in runtime |
| `name` | Identifier name populated by `markOfDeclaration` for diagnostics |

List clauses (`shared`, `runtime`, `keys`, `outputs`) accept comma-separated names and default to `[]` for `shared`, `runtime`, and `keys`. Omitting `entry` skips runtime bundling, an empty `entry:` throws, and `entryOption` requires a non-empty `entry` clause.

### The resource mark

A `@resource` tag produces `{ kind: "resource", runtime?: string[] }` in three forms:

| Form | Behavior |
| :--- | :--- |
| `@resource` | Marks a deploy-only resource; any runtime reference fails |
| `@resource runtime:` | Sets `runtime` to `[]`; `stripForRuntime` replaces the argument with `{}` |
| `@resource runtime: schema` | Sets `runtime` to `["schema"]`; extracts listed properties into the stub |

Any clause on `@resource` other than `runtime:` throws.

### Module tables

`readModuleTable(module, where)` records `marks`, non-type `imports`, non-type `exports` (`{ local }` or `{ source, imported }`), and `stars` (`export * from` sources). `imports` maps each local name to `{ source, imported, statement, specifier }`, using `"default"` and `"*"` for default and namespace imports.

Marks attach from `leadingJsDoc` on top-level or exported `FunctionDeclaration` nodes (including `export default function name`) and single-declarator `VariableDeclaration` statements whose unwrapped initializer `isFunction`. `export default <expr>` is recorded under local name `"*default*"`.

### Nearest tsconfig resolution

`createResolve()` builds a `ResolverFactory` (from `rolldown/experimental`) per distinct `tsconfig.json` directory because `ResolverFactory` ignores `tsconfig: "auto"`:

```ts [packages/build/src/marks.ts]
resolver = new ResolverFactory({
  tsconfig: configFile ? { configFile } : undefined,
  conditionNames: ["node", "import", "default"],
  extensions,
  extensionAlias: {
    ".js": [".ts", ".tsx", ".js"],
    ".mjs": [".mts", ".mjs"],
  },
});
```

`nearestTsconfig(dir)` walks upward from the importer's directory to locate `tsconfig.json` and stops with `undefined` if any segment equals `node_modules`. `createResolve` omits `"notation-runtime"` from `conditionNames` so `Marks` reads the primary package entry holding JSDoc annotations, and skips `node:` specifiers.

### Mark graph traversal

`Marks` caches `ModuleTable | null` per file path and resolves marks across import and re-export chains:

- **`exportMark(file, name, seen)`** – Follows `{ local }` marks, `{ local }` re-exports of local imports (`importMark`), `{ source, imported }` re-exports, and `table.stars` (`export * from`). Guards cycles with `seen` keyed by `${file}#${name}`.
- **`importMark(importer, binding, seen, member)`** – Resolves `binding.source` and looks up `exportMark` for `binding.imported`, or `member` when `binding.imported === "*"`.
- **`hasExport(file, name, seen)`** – Checks whether `file` exports `name` directly or via `export * from`. Unresolvable star sources return `true` so the bundler reports missing exports instead of false resolver errors.

## Static module analysis

`analyzeModule(table, marks)` in `packages/build/src/analyze.ts` collects `freeReferences` over `module.body`, resolves marks, and enforces structural rules on declarations and top-level resource calls.

### Reference mark resolution

For each reference, `markOf(reference, table, marks)` checks `table.marks` first and then `table.imports`. For namespace imports (`binding.imported === "*"`), it requires a non-computed `MemberExpression` where `parent.object === node` and looks up `parent.property.name` as the exported member (`written` becomes `${name}.${member}`).

To identify invocations, `markOf` inspects `holder` (the ancestor immediately above the callee node) and sets `call` when `holder` is:

- **`CallExpression`** with `holder.callee === callee`
- **`NewExpression`** with `holder.callee === callee`
- **`TaggedTemplateExpression`** with `holder.tag === callee`

### Declaration validation

When processing `@declaration` references, `analyzeModule` skips calls inside `insideMarkedWrapper`. That matches calls inside a top-level function or single-variable declaration in the same module whose own binding carries a `@declaration` mark, letting wrapper builders delegate to `$lambda` or `$worker`.

Every remaining `@declaration` reference passes through `readDeclaration`:

1. **Single declaration** – More than one declaration in a module fails with each call's `line:column`.
2. **Call shape** – `call.type` must be `"CallExpression"`, never bare identifier references, `new`, or tagged templates.
3. **Top-level `VariableDeclaration`** – Must be a top-level single-declarator `const`/`let`/`var` bound to an `Identifier`. It may sit inside `ExportNamedDeclaration` and unwrap TypeScript wrappers around the call.
4. **Static object literal** – Must take one `ObjectExpression` argument. Only non-computed `init` `Property` entries are allowed (no spreads, computed keys, or `get`/`set` accessors).

### Entry option checks

When `mark.entryOption` and `mark.entry` are set and the declaration provides that option (such as `entrypoint` on `$worker`), `checkEntryOption` validates the export contract statically:

- Rejects re-exports (`export { X as default } from "..."`) and imported classes.
- Requires the option value to be a non-method `Identifier` matching the local name exported under `mark.entry`.
- Verifies the local declaration statement precedes `declaration.statement.start` (`holder.start <= declaration.statement.start`). This prevents a temporal dead zone `ReferenceError` in the runtime bundle.

### Top-level resource calls

`analyzeModule` records the first `@resource` `MarkedReference` with a `call` and `!reference.ancestors.some(isFunction)` as `analysis.resourceCall`. Later checks use `resourceCall` to detect side-effecting resource creation outside `files.infra`.

## File classification

`FileKinds` in `packages/build/src/files.ts` maps project files to `"infra"`, `"runtime"`, or `"shared"` using `files` globs from `notation.config.ts`. Unset kinds default to `defaultModuleGlobs` (`infra/**`, `runtime/**`, `shared/**`).

### Glob matching

`kindOf(file)` resolves `this.root` via `realRoot` (`fs.realpathSync`), computes the relative POSIX path, and caches results per absolute path:

- **Ignored directories** – Any path segment (excluding the filename itself) matching `isIgnoredDirectory` (`dist`, `node_modules`, or starting with `.`) receives no kind. Paths outside `this.root` also receive no kind.
- **Glob normalization** – `parseGlob` strips leading `!` (negated) and `./`, converts trailing `/` to `<body/>**`, and expands globs without `globCharacters` (`/[*?[{]/`) to `[body, `${body}/**`]`. Matching avoids filesystem calls so new watch-mode directories classify immediately.
- **Negations** – A file matching any negated `!` glob of a kind does not receive that kind.

### Overlap checks

If more than one kind matches a file, `kindOf` throws an overlap error naming both globs (noting defaults when unset). `FileKinds.checkOverlaps()` globs all script files (`/\.[cm]?[jt]sx?$/`, excluding `isIgnoredDirectory`) across `includedPatterns` for all three kinds and calls `kindOf` on each at the start of every infra build.

### Package file detection

`FileKinds.isPackageFile(file)` identifies files belonging to dependencies so they receive no module kind unless explicitly matched by a glob:

1. Matches `nodeModules` (`/[\\/]node_modules[\\/]/`), or
2. Lies outside `this.root`, or
3. Sits beneath a directory strictly below `this.root` whose `package.json` defines a `name` field (`packageName`).

Because monorepo workspace packages resolve via symlinks to real paths outside `node_modules`, rules 2 and 3 classify them as package files. `FileKinds.show(file)` walks upward for `packageName` to format paths relative to package names (such as `@notation/aws/dist/sqs/index.js`).

## Shared module enforcement

`ModuleAnalyses` in `packages/build/src/modules.ts` coordinates a shared analysis cache and enforces module-kind boundaries across both compiler passes.

### Module cache lifecycle

`isProjectModule(id)` accepts non-virtual (`!id.startsWith("\0")`) script files outside `node_modules`. `ModuleAnalyses` populates `#analyses` via `fromSource` (transform hooks), `fromDisk` (`runtimePlugin` entry loading), and `fromFile` (`Marks` and traversal).

`invalidate(file)` checks whether the file contents on disk match `cached.table.module.source`. If unchanged (for example, duplicate Chokidar watcher events), it keeps the cache and `#sharedPassed`; otherwise it evicts the file from `#analyses` and `Marks` and clears `#sharedPassed`.

### Value import traversal

`ModuleAnalyses.checkShared(file)` runs in `buildEnd` of both `infraPlugin` and `runtimePlugin`. Modules already in `#sharedPassed` are skipped; failing modules stay excluded so subsequent builds re-check and fail them.

For any `shared` module, `#checkShared` enforces three invariants:

1. **No declarations** – Calls `checkDeclaration` to reject `@declaration` calls in `infra` or `shared` modules.
2. **No resource functions** – `resourceImport` fails if the module uses a `@resource` import in `usedNames` (value `references` plus local `exports` names). It also fails on namespace member access (`sqs.queue`) or re-exports (`export { x } from`, `export * from`).
3. **No reachable infra or runtime modules** – `#forbiddenImport` runs a breadth-first search over `valueImports` to find the shortest offending import chain (`file:line:col → ... → target`).

`valueImports` tracks load-time import edges:

- Side-effect `import` statements (`specifiers.length === 0`)
- `import` statements with at least one non-type specifier in `usedNames`
- Non-type `export { ... } from` and `export * from` statements

The BFS traverses `shared` and kindless project files, stopping at `isPackageFile` targets and ignoring dynamic `import()`. It fails immediately upon reaching an `infra` or `runtime` module.

## Module export analysis

`packages/build/src/exports.ts` extracts runtime export surfaces without bundling type-only symbols:

| Function | Purpose |
| :--- | :--- |
| `typeOnlyNames(table)` | Collects type-only identifiers not also declared or imported as values |
| `valueExportNames(table)` | Returns sorted export names whose local target is not type-only |
| `otherExports(analysis)` | Filters `valueExportNames` to exclude `entry` and the declaration binding |
| `runtimeExports(analysis)` | Returns `{ entry, others }` for declaration modules with an `entry` |
| `readEntryExports(file, source, platform)` | Computes `valueExportNames` and validates non-`default` exports |

`otherExports` runs on platforms where `reexportsModule` is `true` such as `workerd`. `readEntryExports` parses entry source and runs `platformOf(platform).checkExports` for `bundle()` in [Bundle Cache](./bundle-cache.md).
