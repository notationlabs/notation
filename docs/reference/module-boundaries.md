# Module Boundaries Reference

Notation splits one TypeScript project into an infrastructure bundle for Node and isolated runtime bundles for each deployed function. Static boundary checks keep deploy-time SDKs out of runtime bundles and runtime-only platform APIs out of deploy code.

## Import contract

Every project file receives a module kind from `files` in `notation.config.ts` (`infra`, `runtime`, `shared`, or unmatched). Type-only imports and exports (`import type`, `export type`, and inline `type` specifiers) are erased before bundling and are permitted across every boundary.

### Infra rules

Infra modules run only in Node during `plan`, `deploy`, and `destroy`:

| Rule | Behavior |
| :--- | :--- |
| Runtime declarations | Infra modules can import declaration bindings from `runtime` modules |
| Runtime helpers | Importing non-declaration values from `runtime` modules fails the build |
| Platform imports | Static imports of runtime-only platform modules fail in deploy code |

For example, an `infra` module can import `export const lambda = $lambda(...)` from a `runtime` module, while static `cloudflare:*` imports fail the build. Dynamic `import()` calls remain intact and only fail if executed at deploy time.

### Runtime rules

Runtime modules participate in both builds:

| Build | Behavior |
| :--- | :--- |
| Infra build | Keeps declarations and their dependencies while stubbing runtime-only options |
| Runtime build | Keeps `runtime` and `shared` declaration options and bundles one ESM entry file |
| Infra code leakage | Fails the build if a runtime bundle retains `infra` code or package builder calls |

In the infra build, runtime-only options such as `handler` or `entrypoint` become throwing stubs, and non-declaration runtime modules strip everything except exports imported by deploy code. The runtime build bundles with `codeSplitting: false` and prints the import chain if any `infra` module or `@resource`/`@declaration` call leaks in.

### Shared rules

Shared modules run unmodified in both the infra bundle and every runtime bundle that imports them. Compilation fails when a `shared` module breaks any of these rules:

| Rule | Forbidden pattern |
| :--- | :--- |
| Declarations | Calling a `@declaration` function such as `$lambda`, `$worker`, or `$durableObject` |
| Resource builders | Importing or re-exporting a `@resource` function directly, via namespace, or via `export *` |
| Boundary imports | Value-importing any `infra` or `runtime` module directly or transitively |

### Unmatched files

Project script files that match none of `infra`, `runtime`, or `shared` receive no module kind:

| Rule | Behavior |
| :--- | :--- |
| Auto-discovery | Unmatched files are not scanned for runtime declaration roots |
| Explicit imports | Either build can import an unmatched file as plain code |
| Top-level resources | Runtime bundles fail if they retain top-level `@resource` calls from an unmatched file |

Files in ignored directories or nested packages are excluded entirely. If a retained unmatched file or package triggers a top-level `@resource` error, add the file to `files.infra` or set `"sideEffects": false` on the nearest `package.json`.

## Declaration placement

Static AST analysis enforces strict placement rules on `@declaration` calls (`$lambda`, `$worker`, `$durableObject`):

| Rule | Requirement |
| :--- | :--- |
| Module kind | Must reside in a `runtime` module, never `infra` or `shared` |
| Cardinality | At most one declaration per `runtime` module |
| Top-level binding | Must initialize a single-declarator top-level `const` |
| Options shape | Must take one plain object literal argument |
| Required entry | Module must export the entry name required by the declaration |
| Entry class order | Class named in `entryOption` must be declared earlier and exported |
| Reserved names | Module cannot declare `__notation_declaredIn` or `__notation_unnamed` |

Calls inside a locally defined `@declaration` wrapper function do not count toward the one-per-module limit. The top-level `const` may be exported and wrapped in parentheses or TypeScript expressions such as `satisfies`. The options object cannot contain spread elements, computed property keys, or getters/setters. When a declaration sets `entry` (such as `handler` on `$lambda` or `default` on `$worker`), that export is required; when it sets `entryOption` (such as `entrypoint` on `$worker`), the value must be an identifier naming a `class` declared before the declaration in the same module and exported as `entry` – imported or re-exported classes are rejected.

Place each declaration at the top level of its `runtime` module with a plain object literal:

```ts [runtime/orders.ts]
export const lambda = $lambda({
  id: "orders",
  event: () => sqs.bind(orderQueue),
});
```

## Runtime thunk constraints

Declaration options that supply runtime configuration and references to `infra` resources must stay statically analyzable:

| Constraint | Requirement |
| :--- | :--- |
| Object-literal thunks | Each `keys` option must be a function returning one object literal |
| Direct resource expressions | Kept `infra` resource references must be passed directly, not aliased |
| Object-literal resource config | Resources with runtime options must pass an object literal in `infra` |
| Direct runtime imports | Copied runtime options must be direct named or default imports |
| Declaration output reads | Runtime code cannot read outputs listed in `@declaration outputs:` |

`keys` options (such as `env` on `$lambda` and `bindings` on `$worker`) must be arrow functions or function expressions returning a single object literal (`() => ({ ... })` or `() => { return { ... }; }`) with no spread elements, computed keys, method shorthand, or accessors. Kept `infra` resource expressions (such as `sqs.bind(orderQueue)` or `bindings: () => ({ ORDERS_CACHE: ordersCache })`) must be passed directly as an imported identifier, object-literal member, or namespace member rather than a local `const` or helper return value. When a `@resource` specifies runtime options (such as `schema` on `queue()`), its `infra` call must pass an object literal with no spread hiding that option, and each copied value must be a direct named or default import from a `shared` module or compatible non-infra file rather than a namespace member or inline expression. Static reads of deploy-time outputs (such as `worker.url` on `$worker`) are rejected outside stripped or `keys` options.

## Platform conditions

Runtime builds configure module resolution per target platform:

- **`node` (`$lambda`)** – Resolves package exports with `conditionNames: ["notation-runtime", "node", "import", "default"]`.
- **`workerd` (`$worker`, `$durableObject`)** – Resolves with `conditionNames: ["notation-runtime", "workerd", "worker", "browser", "import", "default"]` and `mainFields: ["browser", "module", "main"]`, marks `cloudflare:*` imports external, normalizes Node built-in imports (`fs` and `node:fs`) to external `node:<name>` modules, and replaces `process.env.NODE_ENV` (default `"production"`).

Helpers that only function inside a runtime bundle (such as `lambda.env()`) rely on the `"notation-runtime"` export condition. Running unit tests against runtime modules outside `notation compile` requires passing `--conditions=notation-runtime` to the test runner.

## Worker export checks

Because `workerd` fails to start a Worker module that exports primitives or module namespace objects, Notation checks all non-default, non-declaration exports of a Worker module statically:

- **Primitive `const` exports** – Rejects top-level `export const` declarations initialized to primitive literals (strings, numbers, booleans, `null`, excluding regex literals), template literals, unary or binary expressions, or `undefined`.
- **Namespace re-exports** – Rejects `export * as ns from "..."`.

Exporting functions, classes, plain objects, `let`/`var` bindings, or type-only exports passes the check. Move shared constants to `shared/` or pass them through `bindings()`.

## Compile checks

Running `notation compile` executes both build passes and verifies every static boundary rule without evaluating infrastructure or requiring cloud credentials:

| Check | Scope |
| :--- | :--- |
| Config globs | Validates `notation.config.ts` and rejects overlapping module globs |
| Declaration AST | Enforces single declaration, object-literal options, and entry exports |
| Shared isolation | Rejects declarations, `@resource` imports, and `infra` or `runtime` imports in `shared` |
| Infra isolation | Rejects non-declaration `runtime` imports and kept static `cloudflare:*` imports |
| Runtime isolation | Stubs `infra` resource references and rejects leaked `infra` code or output reads |
| Worker exports | Rejects primitive `const` exports and `export * as ns` in `workerd` entries |

`notation compile` bundles TypeScript via Rolldown without running `tsc` typechecking. Run `tsc --noEmit` separately in CI or local scripts to verify TypeScript types. See [Module Analysis](../internals/module-analysis.md) for compiler internals.
