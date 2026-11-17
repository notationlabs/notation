# Compiler Marks Reference

`@notation/build` reads JSDoc `@declaration` and `@resource` marks from exported functions to separate deploy-time and runtime builds, enforce module boundaries, and project resource metadata into runtime bundles. See [Compiler Marks](../authoring/compiler.md) for authoring patterns.

## Declaration marks

A `@declaration` tag sits in the JSDoc block comment immediately preceding an exported function declaration or single-declarator function variable (`export function $fn...` or `export const $fn = ...`). Published ESM output must preserve JSDoc comments.

### `DeclarationMark`

`@notation/build` parses `@declaration` tags into `DeclarationMark` objects using semicolon-separated `clause: value` pairs on a single line following `@declaration`:

```ts [@notation/build]
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

### Declaration clauses

Every `@declaration` mark accepts up to seven clauses:

| Clause | Description |
| :--- | :--- |
| `shared` | Option names kept in both deploy-time and runtime builds |
| `runtime` | Option names kept in runtime builds and replaced with throwing stubs at deploy time |
| `keys` | Kept function options whose returned object-literal keys rewrite to `undefined` at runtime |
| `entry` | Module export name invoked by the target platform |
| `entryOption` | Option naming a `class` declared earlier in the same module and exported as `entry` |
| `platform` | Target runtime platform `"node"` or `"workerd"` for generated bundles |
| `outputs` | Return-object fields holding deploy-time outputs blocked from runtime reads |

List clauses (`shared`, `runtime`, `keys`, and `outputs`) accept comma-separated names and default to `[]`; `platform` defaults to `"node"`. Omitting `entry` skips runtime bundling while still recording declaration metadata, while `entryOption` requires a non-empty `entry` clause. An empty `entry:` or `entryOption:` clause, an unknown `platform`, or an unknown clause name throws during mark parsing.

### Call constraints

Calls to `@declaration`-marked builders in user modules must satisfy four static rules (see [Module Analysis](../internals/module-analysis.md)):

- **Top-level binding** – Must initialize a single top-level `const` declaration (`const fn = $myFn({ ... })` or `export const fn = $myFn({ ... })`).
- **Object-literal options** – Must pass one object-literal argument without spreads, computed keys, or getters/setters.
- **Single declaration per module** – At most one top-level declaration call per module is permitted; calls inside another `@declaration`-marked wrapper function are skipped.
- **Module kind boundaries** – Rejected in `files.infra` and `files.shared`; `files.shared` modules also cannot import `@declaration` or `@resource` functions (see [Module Boundaries Reference](./module-boundaries.md)).

## Resource marks

A `@resource` tag identifies an infrastructure constructor or helper so runtime builds know whether and how it can be referenced.

### `ResourceMark`

`@notation/build` parses `@resource` tags into `ResourceMark` objects:

```ts [@notation/build]
export type ResourceMark = {
  kind: "resource";
  runtime?: string[];
};
```

Any clause other than `runtime:` throws during mark parsing.

### Mark forms

`@resource` accepts three forms:

| Form | Behavior |
| :--- | :--- |
| `@resource` | Deploy-only resource that fails the build if called or passed into kept runtime options |
| `@resource runtime:` | Empty projection that replaces resource instances passed into kept options with `{}` |
| `@resource runtime: prop1, prop2` | Selective projection extracting named properties from the first object-literal argument |

In the selective projection form, each projected property value in the resource call's first object-literal argument must be a direct runtime-safe import.

### Invocation detection

`@notation/build` tracks `@resource` references across function calls, `new` expressions, and tagged template literals (such as `` text`...` `` from `@notation/resource`). Calling any `@resource` function directly inside runtime bundle code fails the build.

## Runtime package contract

Libraries shipping `@declaration` builders provide separate deploy-time and runtime implementations under a shared TypeScript surface.

### Package exports

Place the `"notation-runtime"` export condition before `"import"` (and after `"types"`) in `package.json`:

```json [package.json]
{
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "notation-runtime": "./dist/runtime.js",
      "import": "./dist/index.js"
    }
  }
}
```

Deploy-time builds resolve `"import"` (reading `@declaration` and `@resource` JSDoc tags), while runtime bundles resolve `"notation-runtime"`.

### Runtime implementation rules

The `"notation-runtime"` module must follow four contract rules:

- **Export parity** – Export the same runtime-accessible symbol names as the deploy-time entrypoint so identical imports link in both builds.
- **Pure declarations** – Declaration builders in `"notation-runtime"` must have no runtime side effects, because the runtime transform annotates calls with `/*#__PURE__*/` for tree-shaking (see [Transforms](../internals/transforms.md)).
- **Infra-only stubs** – Deploy-only constructors or helpers exported for parity should throw descriptive errors when invoked at runtime and carry `@resource` marks on the deploy entrypoint.
- **Test condition** – Node or test runners executing runtime helpers outside Notation bundles must pass `--conditions=notation-runtime`.

## Output read protection

Listing field names in `outputs:` on a `@declaration` mark (such as `outputs: url`) prevents runtime handlers from reading deploy-time outputs that do not exist until deployment.

### Static bundle check

During runtime and `bundle()` builds, `@notation/build` rejects any static property read (`decl.url`, `decl["url"]`, or access through named or namespace imports) of a listed output outside stripped deploy-only options or `keys:` options.

### Runtime getter guard

Define non-enumerable throwing getters on the `"notation-runtime"` declaration object for every property listed in `outputs:` so indirect or aliased reads fail cleanly at runtime:

```ts [src/runtime.ts]
Object.defineProperty(declaration, "url", {
  enumerable: false,
  get() {
    throw new Error(
      `Runtime code cannot read $job({ id: ${JSON.stringify(config.id)} }).url directly; bind it in env.`,
    );
  },
});
```

Setting `enumerable: false` ensures object spread operations on the declaration do not trigger the getter.

## Evaluation helpers

`@notation/resource` exports three helpers used by deploy-time `@declaration` builders to inspect compiled module paths and defer resource registration until all modules finish loading.

### `getDeclaredIn`

Returns the `DeclaredIn` metadata attached to a declaration return value by the deploy-time build transform, or `undefined` when absent:

```ts [@notation/resource]
export type DeclaredExports = {
  exports: string[];
  starExports: string[];
};

export type DeclaredIn = {
  path: string;
  binding: string;
} & Partial<DeclaredExports>;

export function getDeclaredIn(value: unknown): DeclaredIn | undefined;
```

`path` is relative to the project root with `/` separators, and `binding` is the local variable name holding the declaration. `exports` (non-declaration, non-entry value exports) and `starExports` (`export * from` specifiers) are populated for platforms that re-export module symbols, such as `"workerd"`.

### `getActiveResourceCollection`

Returns the active `ResourceCollection` while a resource graph is being evaluated, or `undefined` outside deploy and plan evaluation:

```ts [@notation/resource]
export function getActiveResourceCollection(): ResourceCollection | undefined;
```

Check `getActiveResourceCollection()` before calling `onEvaluationEnd` so importing a declaration outside graph evaluation does not throw.

### `onEvaluationEnd`

Registers a callback executed in FIFO order after all infra and runtime modules finish loading, before contributions close and pending async validations settle:

```ts [@notation/resource]
export function onEvaluationEnd(
  callback: () => unknown | Promise<unknown>,
): void;

export function evaluationEnded(): boolean;
```

Throws if called when no resource collection is active. Callbacks can register additional `onEvaluationEnd` callbacks (appended to the end of the queue); `evaluationEnded()` returns `true` once the queue begins draining.
