# Compiler

The compiler builds two kinds of bundle with Rolldown: one infra bundle, which the CLI runs to collect the resource graph, and one runtime bundle for each function.

Source: `@notation/build` (plugins and source transforms), `@notation/cli` (`packages/cli/src/compile.ts`), `@notation/core`

## Two-pass compilation

`compile({ entryPoint, files })` in `@notation/cli` runs two passes. Both share one `ModuleAnalyses`, which holds the kind of each file. See [Module kinds](#module-kinds).

1. **Infra pass** – `compileInfra` bundles the infra entry with `infraPlugin`. It returns the declaration modules in the bundle, as `DeclarationModule[]`, and a `close` function that stops the watcher in watch mode. `compile` returns a function that stops both watchers.
2. **Runtime pass** – `compileRuntimeModules` bundles each of those modules with `runtimePlugin`, as the code for one function. The bundles build at the same time.

```ts [@notation/build]
type DeclarationModule = {
  path: string; // absolute path of the module
  binding: string; // local name of the declaration, such as "lambda"
  entry?: string; // the export that the platform calls, such as "handler". Without it, there is no runtime bundle
  platform?: PlatformName; // the mark's platform, such as "workerd"
};
```

`platform` is absent for the default platform, `node`, in both the mark and the `DeclarationModule`. It is copied from the mark as it is, also for a declaration with no entry. The record has no exports: the runtime build reads the module's exports from disk, for the reason in [The entry](#the-entry). So in watch mode, a change to a module's exports rebuilds its runtime bundle, but doesn't restart the runtime watcher. The runtime build and the `declaredIn` record both use `runtimeExports` and `otherExports` in `packages/build/src/exports.ts`.

### Platforms

Each platform has one definition in `packages/build/src/platforms.ts`, of the type `Platform`. A definition holds the Rolldown input options of the runtime bundle, with its plugins, whether the runtime entry also re-exports the module's other exports (`reexportsModule`), and an optional `checkExports` that fails the infra build for an export value that the platform doesn't start with. `platformOf(name)` returns the definition for a mark's `platform`, or for `node` when it is absent. The infra strip, the runtime plugin and `compileRuntimeModules` read the definition. None of them tests for a platform's name.

Only the infra pass decides which modules are declaration modules. The runtime pass bundles the list that the infra pass returns and no others, so the two passes can't disagree.

### The generated infra entry

The infra pass also finds declaration modules that the entry doesn't import. The input of the infra build is not the entry file but a virtual module, `notation:infra-entry`, from `infraEntryPlugin` in `@notation/build`. Its `load` hook globs the files that `files.runtime` matches, analyses each one, and imports the entry and then each file that holds a declaration:

```ts [notation:infra-entry]
import "/project/infra/index.ts";
import "/project/runtime/nightly-report.ts";
import "/project/runtime/todos.ts";
```

The output keeps the entry's name, such as `dist/infra/index.mjs`. `runtime/todos.ts` is imported by the entry as well, but an ES module runs once, so the second import does nothing. `infraPlugin` then strips each of these modules as usual.

**The generated entry imports only files that hold a declaration.** A runtime file without one, such as a file that calls `Sentry.init()`, doesn't run at deploy time.

In watch mode, the plugin adds the base directory of each glob to the watched files, such as `runtime/` for `runtime/**`, and `jobs/` for `jobs`. A new file in that directory starts a rebuild, and the `load` hook globs the files again. If the base directory doesn't exist yet, the plugin watches its nearest parent that exists, up to the project root, so a `runtime/` directory created during watch is seen.

The base directory of a glob such as `**/*.ts` is the project root, so the watcher would see each build's output in `dist/` and each deploy's writes to `.notation/`. **Both would start another build, and in `notation watch` another deploy.** So the scan and the infra watcher skip the same directories at any depth: `dist/`, `node_modules/` and dot-directories. `infraWatchExclude` holds the watcher's globs.

## Module kinds

Both plugins read the kind of each module from `FileKinds` in `packages/build/src/files.ts`. `FileKinds` takes the globs of `files` from the config, and uses the default globs for each kind that the config doesn't set:

```ts [@notation/core]
const defaultModuleGlobs = {
  infra: ["infra/**"],
  runtime: ["runtime/**"],
  shared: ["shared/**"],
};
```

`kindOf(file)` matches the file's path, relative to the project root, against the globs with `path.matchesGlob`. The root is resolved to its real path, because Rolldown gives real paths. A glob that ends in `/` is read as that folder's `**`. A glob with no `*`, `?`, `[` or `{`, such as `"infra"`, is matched both as written and as `infra/**`. Neither reads the file system, so a folder created in watch mode is matched. `KindMatch.glob` keeps the glob as the config writes it, for error messages. A glob that starts with `!` excludes the files that it matches from its kind. A file in `dist/`, `node_modules/` or a dot-directory has no kind, and so does a file outside the root. `kindOf` fails if two kinds match the file. The result depends only on the path, so `FileKinds` keeps it for the life of the watcher.

**The infra entry checks every file for two kinds on each build.** Its `load` hook globs the files of all three kinds, and calls `kindOf` on each, so a conflict fails the build even for a file that nothing imports.

Each kind changes the builds in one place:

| Kind      | Where                         | What                                                                                                                                         |
| --------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `infra`   | `runtimePlugin`'s `transform` | Returns `moduleSideEffects: false`, and adds the module to the bundle check.                                                                 |
| `runtime` | `infraEntryPlugin`'s `load`   | Imports each file with a declaration after the entry.                                                                                        |
| `shared`  | `buildEnd` of both plugins    | Calls `ModuleAnalyses.checkShared` for each shared module in the build. A module that has passed the check since the last change is skipped. |
| any       | `infraPlugin`'s `transform`   | Fails for a declaration in an `infra` or `shared` module, through `checkDeclaration`.                                                        |

A declaration is found and stripped in any project module outside `node_modules`, whatever its kind. So a `$lambda` module that infra imports is deployed even if no glob matches it.

### Package files

A package file has no kind. `FileKinds.isPackageFile` counts a file in `node_modules/`, a file outside the project root, and a file under a folder below the root whose `package.json` has a `name`. A workspace package resolves to its real path, outside `node_modules/`, so the last two rules cover it. A package file that a glob matches keeps its kind.

A package file is infra only if `files.infra` matches it. `FileKinds.kindOf` gives no kind to a file outside the root, so a file of a workspace package outside the root is never infra. A package file that no glob matches is not infra, even if it calls a resource function at its top level. It keeps its side effects unless the nearest `package.json` sets `"sideEffects": false`. If such a file is left in the bundle, the bundle check fails, and `ModuleAnalyses.resourceCallAdvice` adds advice to the error. The build doesn't read the package's `sideEffects`, so the advice covers both cases. If the function doesn't use a value from the file, the nearest `package.json` can set `"sideEffects": false`. If it does, the function must read infra values through the declaration's `env()`, and a plain value that it needs must move to a file that doesn't call a resource function. A file that a glob matches gets no such advice. A file in `node_modules/` isn't analysed, so its error has no advice.

### The shared check

`checkShared` fails for a shared module that:

1. holds a declaration,
2. imports or re-exports a resource function, by name, through a namespace member such as `sqs.queue`, or through `export * from`,
3. reaches an infra or runtime module through its imports.

For step 3, the check walks the imports breadth first, so the error names the shortest chain. An edge is an `import` with no specifiers, an `import` with a name that the module uses as a value, an `export { x } from` or an `export * from`. The value names come from `analysis.references`, which leaves out names in types and includes JSX tags such as `<Comp />`, and from local `export { x }` specifiers. The walk passes through shared modules and files with no kind. It stops at package files and doesn't follow dynamic `import()`.

The check runs in `buildEnd`, not in `transform`. It reads the modules that the shared module imports, and in watch mode an edit to one of them doesn't run the shared module's `transform` again. `buildEnd` runs on every rebuild, so the check sees the edit.

`ModuleAnalyses` remembers each shared module that has passed the check, until any file changes. A later build skips a module that it remembers. It doesn't remember a module that fails, so each build that includes the module checks it again and fails. In watch mode, an error in a shared module that infra and N functions import fails N + 1 builds. None of them writes its bundle, so `notation watch` doesn't deploy a function that includes the module. The CLI prints the error for each failed build. The messages differ only in the plugin name, and the CLI doesn't merge them. Each watcher reports a change, and the file system can report one change twice, so `invalidate` ignores a file whose source is the same as its analysis. This keeps a module that passed from being checked again for the same change. A shared module that neither build includes isn't checked.

## Marks

The compiler finds declaration functions and resource functions by JSDoc tags in the packages that export them. For example, in `@notation/aws`:

```ts [packages/aws/src/lambda/lambda-declaration.ts]
/**
 * Declares the Lambda function that its module deploys as.
 * @declaration shared: id, event, env; keys: env; entry: handler
 */
export function $lambda(config) {
  /* ... */
}
```

```ts [packages/aws/src/sqs/queue.ts]
/** @resource runtime: schema */
export function queue(config) {
  /* ... */
}
```

```ts [packages/aws/src/api-gateway/api.ts]
/** @resource runtime: */
export function api(config) {
  /* ... */
}
```

| Mark           | Marks                                        | Clauses                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@declaration` | A function that declares a function resource | `shared:` options that both builds keep. `runtime:` options that only run in the function. `keys:` kept options whose value returns an object literal, of which the runtime build keeps only the keys. `entry:` the export that the platform calls. A declaration with no `entry:`, such as a Durable Object namespace, has no runtime bundle. An empty `entry:` fails the build. `platform:` `node`, the default, or `workerd`. |
| `@resource`    | A function that declares a resource          | `runtime:` options of the resource that a function reads when a kept option of a declaration names the resource, such as `schema` in `sqs.bind(orderQueue)`. `runtime:` with no options means the resource becomes `{}`, as `api()` does. A bare `@resource` can't be read in a function. See [The runtime strip](#the-runtime-strip).                                                                                           |

The tags are in JSDoc because Rolldown and tsdown keep JSDoc comments in a package's `dist`, and drop other block comments.

`Marks` in `packages/build/src/marks.ts` resolves the marks of a module's imports. For each import, it resolves the specifier with Rolldown's resolver, the `node`, `import` and `default` conditions, and the nearest tsconfig's `paths`. Then it reads the target module and follows `export { x } from`, `export * from` and `export { x }` of an import, to the module whose function has the mark. A function that is declared under one name and exported under another, as tsdown emits it in a shared chunk, keeps its mark. Each module is parsed once, with Rolldown's `parseSync`, until it changes.

## Module analysis

`analyzeModule` in `packages/build/src/analyze.ts` reads two facts from each project module:

1. **The declaration**, if the module has one. Every reference to a function marked `@declaration` must be a call written `const name = fn({ ... })` at the top level, with one object literal that has no spread, computed keys or accessors. Any other reference fails the build with its file and line. A module with two declarations fails too. The analysis records the declaration's binding, its call, and its options by key.
2. **The first call to a resource function at the top level**, outside any function, as `resourceCall`. The runtime strip uses it to fail a kept option that refers to a value from a file with no kind, and the bundle check uses it to say in an error how to leave the call out of the function. See [Package files](#package-files).

A reference inside a function that is itself marked `@declaration` in the same module is skipped. This lets a user write a wrapper around `$lambda` and mark the wrapper.

`ModuleAnalyses` keeps one analysis for each file, shared by both passes, and drops it when the file changes.

## The infra build

`infraPlugin` does three things:

- It leaves installed packages external, so the infra bundle imports them from the project's `node_modules`. A bare specifier that names no installed package, such as a tsconfig path alias like `runtime/todos`, is bundled.
- It replaces each declaration module with the output of `stripForInfra`.
- It replaces each other runtime module with the part that code that runs at deploy uses. See [Runtime modules without a declaration](#runtime-modules-without-a-declaration). It fails the build if that code uses a module that only another platform provides, such as `cloudflare:workers`. See [Platform modules](#platform-modules).

### The infra strip

`stripForInfra` in `packages/build/src/infra-strip.ts` keeps the declaration's statement and every top-level statement that it uses, by following the names that the kept statements refer to. A name that is used only in a type doesn't count. It removes every other statement, and the import specifiers that kept code doesn't use:

::code-group

```ts [runtime/orders.ts]
import { $lambda, sqs, type LambdaHandler } from "@notation/aws/lambda";
import { orderQueue } from "infra/orders";
import * as Sentry from "@sentry/node";

Sentry.init({ dsn: "..." });

export const lambda = $lambda({
  id: "orders",
  event: () => sqs.bind(orderQueue),
  env: () => ({ ORDER_QUEUE_URL: orderQueue.url }),
});

export const handler: LambdaHandler<typeof lambda> = async (event) => {
  // ...
};
```

```ts [infra build]
import { $lambda, sqs } from "@notation/aws/lambda";
import { orderQueue } from "infra/orders";

export const lambda = __notation_declaredIn(
  $lambda({
    id: "orders",
    event: () => sqs.bind(orderQueue),
    env: () => ({ ORDER_QUEUE_URL: orderQueue.url }),
  }),
  "runtime/orders.ts",
  "lambda",
);

function __notation_declaredIn(value, path, binding, moduleExports) {
  if (
    (typeof value === "object" && value !== null) ||
    typeof value === "function"
  ) {
    Object.defineProperty(value, Symbol.for("@notation/declaredIn"), {
      value: { path, binding, ...moduleExports },
    });
  }
  return value;
}
```

::

1. `Sentry.init()` and the `handler` are removed, so neither runs at deploy.
2. The declaration is wrapped in `__notation_declaredIn`, which records the module's path and the binding's name on the declaration's value, under `Symbol.for("@notation/declaredIn")`. `getDeclaredIn` in `@notation/resource` reads the same key. The helper is written into the module, so the user's project doesn't need to resolve `@notation/resource`. The path is relative to the project root, so the infra bundle is the same on every machine. The name `__notation_declaredIn` is reserved: a module that declares it fails the build. For a declaration marked `platform: workerd` that has an entry, the record also holds `exports`, the exports that the runtime bundle re-exports besides the entry, and `starExports`, the specifiers of the module's `export * from` statements. The framework doesn't check these names. They are there so that a provider's `$worker` can check at plan time that the Worker exports each bound Durable Object class under the name that the namespace records. workerd doesn't check this at startup: it logs a warning, and each call to the namespace fails.
3. Each option that the mark lists under `runtime:` is replaced with a function that throws. `$lambda` lists none. The strip doesn't follow the names in `runtime:` options, so a class that an option names, and the class's imports, such as `cloudflare:workers`, are removed. The function's name depends on the option's value:
   - A name that the module declares or imports, such as `class: Counter`, gives a function with that name, so the declaration can read `config.class.name`. The name is the local name at the call site: after `import { Counter as C }`, `class: C` gives `"C"`, and after `const Counter = class Foo {}`, `class: Counter` gives `"Counter"`. So a Worker must export the class under the name that is written in the option.
   - Any other value, such as `ns.Counter`, `make()`, a class expression, a method such as `class() {}`, or a global such as `undefined`, gives a function whose name is `""`. The function comes from a second helper that the strip writes into the module, `__notation_unnamed`, which returns an arrow function. Rolldown removes a comma or `void` in front of an arrow function in an object literal, so `(0, () => {})` would take the option's key as its name in the infra bundle. The framework doesn't know which options need a name, so a provider rejects an empty name itself. The name `__notation_unnamed` is reserved, like `__notation_declaredIn`.

   A name that is the value of a `runtime:` option can still be used elsewhere in the code that the infra copy keeps, such as `label: Counter.name`. The infra copy then keeps the class. If the class uses `cloudflare:workers`, the infra build fails. See [Platform modules](#platform-modules).

The strip fails the build if the module doesn't export the mark's `entry`, such as `handler`. An entry that comes through `export * from` counts: `Marks.hasExport` follows the star exports to the module that declares it.

The plugin also fails the build if a module imports a name from a declaration module that the stripped copy doesn't export. For each named import and `export { x } from` of a project module, it resolves the specifier with `Marks`, and asks `infraInterface` for the exports that the target's stripped copy keeps. In a declaration module, only the imports that the stripped copy keeps are checked. Without this check, Rolldown reports a missing export, which doesn't say why the export is missing. A namespace import, such as `import * as orders`, isn't checked. In watch mode, Rolldown 1.3 transforms every module again on each rebuild, so the check also runs for a module that didn't change.

**An effect that the declaration doesn't name is lost.** A side-effect import, a mutation such as `settings.memory = 2048`, or a `.env` loader doesn't run in the infra build, even when an option reads the value that it sets.

### Runtime modules without a declaration

Runtime code doesn't run at deploy. The infra build strips each module that `files.runtime` matches and that has no declaration, such as `runtime/cls.ts` when a declaration imports a constant from it. The copy keeps the exports that code that runs at deploy uses, and the top-level statements that those exports need. Everything else is removed, including side-effect imports and statements with side effects, such as `globalThis.registered = true` or `Counter.prototype.extra = 1`. Tree shaking alone would keep such statements. Marking the module free of side effects doesn't help either: Rolldown 1.3 then only leaves out a module that no kept code imports, and keeps the statements of a module that it includes.

What a module keeps depends on the modules that import it, so `RuntimeStrips` in `packages/build/src/infra-strip.ts` solves the whole infra build at once, from its roots: the infra entry and the declaration modules, which `infraRoots` lists, as for the generated entry.

1. A declaration module uses the names that its declaration refers to, except in `runtime:` options, and the names that the statements it keeps refer to.
2. A module that isn't a runtime module, such as an infra, shared or unmatched module, runs whole. It uses every name that it imports and re-exports, and each module that it imports runs.
3. In a stripped module, each used export keeps the statement that declares it, and the statements that those refer to. A name that a kept statement imports is used in turn. A re-export passes the use on, also through `export *`. A member of a namespace import, such as `names.PREFIX`, uses that export. Any other use of a namespace uses every export.

A module's kept statements only grow, so the solve ends, also for modules that import each other. The plugin keeps the solve until the next build, or until the watcher reports a change. A module that kept code doesn't import keeps nothing, such as a runtime module that infra imports only for its side effects. A dynamic `import()` isn't followed, so a runtime module that is only imported dynamically is also empty. Measured on a generated project with 5,000 runtime modules, the solve takes about 30 ms once the modules are parsed, against about 1.6 s for the whole infra build.

A statement is kept or removed whole. `export const a = 1, b = env.KV` keeps `b` when `a` is used.

### Platform modules

Some modules exist only where a platform runs the function, so code that runs at deploy can't use them. Each platform's definition lists these modules in `provided.modules`, and says where they exist in `provided.availableIn`, which the errors quote. On workerd, they are the `cloudflare:` modules, such as `cloudflare:workers`, which are available in "a Worker". The infra build runs on Node, which can't load them.

The strip removes an import of a provided module unless kept code uses it. The solve fails the build when kept code in a declaration module or a stripped module uses a name from a provided module. The error names the code that runs at deploy and first needed the name, and the module that imports the provided module if that is another module:

- In a declaration module, the reference in the declaration, such as `label can't be used in a $durableObject() call, which runs at deploy, because it depends on cloudflare:workers, which is only available in a Worker (runtime/cls.ts imports it)`. It says to pass the name only in a `runtime:` option, or to move what the infra build needs to a module that doesn't import the provided module.
- In a module that runs whole, the import or re-export, such as `infra/main.ts:1:10: kv can't be used at deploy, because it depends on cloudflare:workers, which is only available in a Worker (runtime/kv.ts imports it)`.

A module that runs whole isn't checked. If it uses a provided module, the bundle check below fails the build. If kept code doesn't use the import, tree shaking drops it, because the plugin resolves provided modules as external and free of side effects.

A dynamic `import()` of a provided module isn't changed. The plugin resolves it as external, and it fails only if it runs, such as `await import("cloudflare:workers")` in a `try` block. As a backstop, the plugin fails the build, in `generateBundle`, when a static import of a provided module is still in the bundle's code, and names the importing file, such as an infra module with `export * from "cloudflare:workers"`. Without this check, the infra bundle fails with `ERR_UNSUPPORTED_ESM_URL_SCHEME` when deploy imports it. The plugin reads the bundle's code, because Rolldown's `chunk.imports` also lists the imports that tree shaking removed. Imports with other schemes, such as `bun:sqlite`, or a tsconfig path alias with a colon, such as `app:db`, resolve as before.

### Recording the declaration modules

The plugin records a `DeclarationModule` for each module that it strips. In `generateBundle`, it keeps the modules that are in the finished bundle, sorts them by path, and calls `onDeclarationModules`. `compileInfra` returns that list.

## The runtime build

`compileRuntimeModules` builds one bundle for each declaration module that has an entry, to `dist/<module path>/index.mjs`, as one file with no code splitting. The build takes its input options from the platform's definition. On `node`, the build resolves packages with the conditions `notation-runtime`, `node`, `import` and `default`. On `workerd`, it uses Rolldown's `neutral` platform, the conditions `notation-runtime`, `workerd`, `worker`, `browser`, `import` and `default`, and leaves `cloudflare:` and `node:` imports external. A bare Node built-in, such as `events`, becomes an external import of its `node:` module, which workerd provides under the `nodejs_compat` flag. This holds even when an installed package, such as a polyfill, has the same name. workerd has no `require`, so a `require()` of a built-in, such as `require("events")` in a CommonJS package, is resolved to a generated module that imports the `node:` module's default export and assigns it to `module.exports`, as wrangler does. `process.env.NODE_ENV`, with the `global.` and `globalThis.` forms, is replaced with the build's `NODE_ENV`, or `"production"` when it isn't set, as wrangler does on deploy. Through `notation-runtime`, `@notation/aws/lambda` resolves to `dist/lambda/runtime.js`, which has the same exports as the infra entry and none of the infra code. Its `$lambda` returns a declaration with `env()` and `decode()`, and builds no resources.

### The entry

The bundle's entry is generated by `createRuntimeEntry`. It re-exports the module's entry. On `workerd`, it also re-exports the module's other value exports, except the declaration, because Cloudflare reads named exports such as Durable Object classes. The module is then the Worker's main module. Measured under miniflare 5.20261012.0-beta, workerd starts a main module whose exports, besides the default handler, are functions, classes or objects whose prototype chain ends in `Object.prototype`. That includes `{}`, arrays, `Date`, `Map`, `Promise`, class instances, frozen objects and TypeScript enums, and objects whose `fetch` or `queue` field has the wrong type. It fails to start for a number, string, boolean, bigint or symbol ("Incorrect type for map entry ... not of type 'function or ExportedHandler'"), for `null` or `undefined`, including `export let x;` ("Cannot initialize ... from an undefined or null value"), and for an object with a null prototype, such as a module namespace object ("prototype chain does not end in Object").

The infra strip fails the build through workerd's `checkExports`, with the file and line, for the cases that it can see in the module: an exported `const` whose initialiser is always primitive, such as a literal, a template literal, a unary or binary expression, or `undefined`, and `export * as ns from`. It doesn't skip such an export, because wrangler would reject the same module. A `let` or `var`, such as `export let later;` or `export let count = 0;`, isn't checked, because the module can assign it later. A value that comes from another module, such as `export { version } from "./meta"`, or from another name, such as `const v = "1"; export const version = v;`, isn't checked, and neither is a namespace import that the module exports, such as `import * as ns from "./x"; export { ns };`. workerd then fails to start the Worker.

Types exported without the `type` keyword, such as `export { Env }` of an interface or of a type import, are not re-exported. A type re-exported from another project module, such as `export { Env } from "./types"`, or a namespace that holds only types, is re-exported, and Rolldown fails the runtime build with a missing export that names the file and the name, such as `"Env" is not exported by "runtime/types.ts"`. Write `export type` for these. A name from `export * from` is not re-exported. A name that is not an identifier, such as `"my-class"`, is quoted.

In watch mode, the entry reads the module from disk when the bundle builds, not when the infra build found the module. A change to the module rebuilds the runtime bundle before the infra rebuild replaces the runtime watcher, so the bundle has the module's current exports. If the module no longer has a declaration with an entry, or no longer exports the entry, the generated entry exports nothing. `generateBundle` removes the output of a bundle whose entry exports nothing, so the build writes nothing and the last bundle stays in `dist`. The infra build then either fails, and keeps its last bundle too, or no longer bundles the module. `notation watch` deploys on any change under `dist`, so an empty bundle would deploy with the old infra bundle.

```ts [generated runtime entry]
export { handler } from "/path/to/my-app/runtime/orders.ts";
```

The declaration is not an export of the entry, so the bundler can drop it when the handler doesn't use it. Lambda's handler setting is `index.handler`.

### The runtime strip

`stripForRuntime` in `packages/build/src/runtime-strip.ts` reduces the declaration to the options that the function uses:

::code-group

```ts [runtime/orders.ts]
import { orderQueue, refundQueue } from "infra/orders";

export const lambda = $lambda({
  id: "orders",
  event: () => sqs.bind(orderQueue, { batchSize: 5 }),
  policy: () => [refundQueue.grant(["SendMessage"])],
  env: () => ({ ORDER_QUEUE_URL: orderQueue.url }),
});
```

```ts [runtime build]
import { Order as __notation_schema_0 } from "/path/to/my-app/shared/schema.ts";

export const lambda = /*#__PURE__*/ $lambda({
  id: "orders",
  event: () => sqs.bind({ schema: __notation_schema_0 }, { batchSize: 5 }),
  env: () => ({ ORDER_QUEUE_URL: undefined }),
});
```

```ts [infra/orders.ts]
import { queue } from "@notation/aws/sqs";
import { Order, Refund } from "shared/schema";

export const orderQueue = queue({ id: "orders", schema: Order });
export const refundQueue = queue({ id: "refunds", schema: Refund });
```

::

1. Options that the mark lists under neither `shared:` nor `runtime:` are removed. For `$lambda`, `policy`, `runtime`, `timeout`, `memory` and `concurrency` go. `id` stays, so the function can read `lambda.id`.
2. Each `keys:` option keeps the keys of the object that it returns, and each value becomes `undefined`. The option must be `() => ({ ... })`, or a function whose body is one `return { ... }`, with no spread or computed keys.
3. In a kept option, a resource from an infra module is replaced with the resource's runtime options, wherever it appears. See [Resource arguments](#resource-arguments).
4. An import whose uses the strip removed is removed too. For example, the import of `orderQueue` and `refundQueue` goes once their uses in `event`, `policy` and `env` are gone. An import that had no uses to begin with stays, because it may be there for its side effects, such as a polyfill.
5. The binding and its export stay, so an infra module that imports `lambda` still links.
6. The call is marked `/*#__PURE__*/`, so the bundler drops a declaration that the bundle doesn't use. A Worker that re-exports a Durable Object class imports the class's module, and the namespace's declaration in that module is dropped. So the runtime half of a declaration function, such as `$lambda` from `dist/lambda/runtime.js`, must have no side effects. This includes a wrapper that a project marks `@declaration` itself: the wrapper has no runtime half, so its body runs in the function, and a call whose binding the function doesn't use is dropped with its side effects.

The strip then checks the kept options. A reference to an import from an infra module, or a call to a resource function, fails the build with its file and line. So does a reference to an import from a file with no kind outside `node_modules/` that calls a resource function at its top level, such as `dlq` in `event: () => sqs.bind(dlq)`. This includes a file of a workspace package or a package folder. The function can't load that file, and adding it to `files.infra` gives the error for an infra module. So both errors say to move a plain value that a kept option uses to a shared module, or to a file with no kind.

### Resource arguments

`sqs.bind(orderQueue)` names a queue, but the function needs only the queue's schema, and the function can't load `infra/orders.ts`. So step 3 of the strip replaces the argument with an object of the queue's runtime options: `sqs.bind({ schema: __notation_schema_0 })`.

`sqs.schema(Order)` names no resource, so the strip leaves it as it is. `Order` comes from a shared module, which the function loads.

The replacement doesn't depend on where the resource appears in the option. `apiGateway.bind(userApi).defineRoute({ method: "GET", path: "/user", schema: null, auth: userAuth })` becomes `apiGateway.bind({}).defineRoute({ method: "GET", path: "/user", schema: null, auth: { claims: __notation_claims_0 } })`. `userApi` becomes `{}` because `api()` is marked `@resource runtime:` with no options, and `userAuth` becomes its claims because `jwtAuthorizer()` is marked `@resource runtime: claims`. The other options stay as they are, so a `schema` option other than `null` must come from a shared module.

The strip finds the options in four steps:

1. **An expression in a kept option names an import from an infra module.** The expression can be a name, such as `orderQueue`, or a member of an object literal or of a namespace import, such as `queues.orders` or `infra.orderQueue`. The strip replaces the whole member path, and doesn't replace the names in it on their own. Any other expression is left as it is.
2. **The strip follows the import to the resource.** It follows re-exports and imports to the `const` that the infra module exports, and member keys through object literals. A `let` or `var` is left as it is, because the module can assign another value to it, and it fails the build like any other reference to an infra module. The value must be a call to a function marked `@resource`, such as `queue({ ... })`. Any other value fails the build, because the strip can't read its options. The strip can't tell a resource that a helper or a loop makes from a plain value, such as a schema made by `v.object(...)`. So the error says to declare a resource with a call to its resource function, and to move a plain value to a shared module. A resource with a bare `@resource` mark is left as it is, and fails the build like any other reference to an infra module. A resource marked `@resource runtime:` with no options becomes `{}`.
3. **The strip reads each option that the mark lists after `runtime:`.** `queue` is marked `@resource runtime: schema`, so the strip reads the `schema` property of the call's object literal. If the property is missing and the literal has a spread, the build fails, because the spread may hold the option. The property's value must be a name that the infra module imports by name, or as a default import, from a shared module, a package, or a file with no kind. These are the files that the runtime build bundles as they are. A schema that the infra module defines, a member of a namespace import such as `schemas.Order`, and an expression such as `Order.extend({ ... })` fail the build, because the strip can only copy an import. A schema imported from an infra or runtime module fails the build too, because the function can't load it there. So does a schema imported from a file with no kind that calls a resource function at its top level, as for any other value from such a file.
4. **The strip adds an import of each option to the function's module**, under the name `__notation_<option>_<n>`.

A member of a resource, such as `orderQueue.schema`, is not replaced. It is a reference to an infra module, and fails the build like any other.

**The added import uses the absolute path of the file that infra imports the option from, and not infra's specifier.** This matters because the import moves from `infra/orders.ts` to `runtime/orders.ts`. A relative path, such as `../shared/schema`, would resolve from the wrong folder. A tsconfig alias, such as `shared/schema`, resolves through the `paths` of the nearest tsconfig, and the function's module can have a different nearest tsconfig from the infra module. A package keeps its name, such as `@acme/schemas`, so that the runtime build resolves it with the `notation-runtime` condition. If the infra module's import doesn't resolve, the build fails.

### Leaving infra out

An import loads its module and runs the module's top-level code, even when nothing uses the import's bindings. So step 4 of the strip is what keeps `infra/orders.ts` out of the bundle of `runtime/orders.ts`. The TypeScript transform removes an unused import by default, but with `verbatimModuleSyntax` it keeps every import that isn't `import type`, so the strip doesn't rely on it.

An infra module can also be reached through a module that the strip doesn't change, such as a helper with no kind that imports `orderQueue` and uses it in a function the handler never calls. For that case, the runtime plugin marks each infra module free of side effects, through the `moduleSideEffects` result of its `transform` hook. The bundler then drops the infra module if nothing in the bundle uses its bindings. Other modules keep their side effects, so a setup module that imports infra still runs its top-level code. An infra module is a file that `files.infra` matches. A file with no kind that calls `queue()` at its top level, such as `lib/queues.ts`, is not marked, so the bundler keeps it if the function imports it, and the check below fails the build. The error then says to add the file to `files.infra`. For a package file, it says to set `"sideEffects": false` in the nearest `package.json` if the function uses no value from the file, and otherwise to read infra values through `env()`. If the file holds a declaration, it can't be an infra module, so the error says to move the call to an infra module instead.

A side-effect import, such as `import "../infra/setup"`, binds nothing, so the bundler always drops an infra module that is imported this way, and the function never runs its code. The build doesn't fail for such an import. The import may still matter in the infra build, where it registers resources. Code that the function needs belongs in a shared module, or in a file with no kind.

The provider packages declare `"sideEffects": false` in their `package.json`, so the bundler also drops a package module whose exports the function doesn't use.

In `generateBundle`, the plugin checks that no infra module is left in the bundle. A handler that reads `orderQueue.url` directly keeps `infra/orders.ts` in the bundle, and the build fails:

```
infra/orders.ts, an infra module (files.infra: "infra/**", the default), can't be used in the function in runtime/orders.ts, because an infra module only runs at deploy. The function uses orderQueue at runtime/orders.ts:15:31, and imports infra/orders.ts through runtime/orders.ts → infra/orders.ts. Read infra values in the function through the declaration's env(). Move a plain value that the function needs, such as a constant, to a shared module (files.shared).
```

The error names the infra module and says why it is infra. It lists each reference to an import from the infra module, in any project module in the bundle. Then it names the shortest chain of imports from the function's module to the infra module. References in the declaration's options are left out, because the strip has removed or checked them. The list can include a reference in code that tree-shaking dropped, since the module is in the bundle either way. If the plugin finds no reference, such as for an `export { orderQueue } from "../infra/orders"`, the error names only the chain.

The check reads Rolldown's render info for each module, `renderedLength` and `renderedExports`. Rolldown computes it before the minify pass, and the runtime build keeps Rolldown's default minify, `"dce-only"`, which drops unused code after rendering. So code that refers to infra fails the build even when the minify pass would remove it. For example, a handler that calls a helper from an infra module and ignores the result fails the build, although the final bundle doesn't contain the call. This is why the error says that the function uses the infra module at a line, and not that the final bundle contains it.

**The runtime build turns off `optimization.inlineConst`.** With Rolldown's default, `{ mode: "smart" }`, the bundler copies some imported constants into the module that uses them, such as a string of up to 3 characters, a boolean or a small number. A handler that returns `REGION` from an infra module, with `export const REGION = "eu"`, would then render as `() => "eu"`. The infra module would render nothing, and the check would pass. With the option off, the infra module keeps its `const` and the build fails. `runtimePlugin` doesn't set the option, so a build that uses the plugin must set it. The bundles of the examples are the same size with the option on or off.

The plugin also checks infra functions from packages. `sideEffects: false` only drops what the function doesn't use, so a handler that calls `queue()` from `@notation/aws/sqs` would bundle it, with the AWS SDK. For each package module in the bundle, the plugin looks up the mark of each export that is left after tree-shaking. An export marked `@resource` or `@declaration` fails the build. The error names each reference to the export, such as `queue at infra/helpers.ts:4:10`, and the chain of imports to the package module. As for infra modules, the check reads the code before minify, so an unused call to `queue()` fails the build. This check also catches an infra module that calls a resource function through a factory, because the chain passes through the module that calls the factory. `$lambda` from the runtime entry of `@notation/aws/lambda` has no mark, so it passes.

## Import cycles

A runtime module imports infra for its options, and infra imports the runtime module to wire it, so the two modules often import each other. Two rules keep the cycle safe:

1. Options that refer to infra are functions, such as `env: () => ({ ... })`, and infra passes declarations as functions, such as `() => lambda`.
2. `$lambda` and the wiring calls, `eventSourceMapping()`, `route()` and `schedule()`, register callbacks with `onEvaluationEnd` from `@notation/resource`. The callbacks run when infra has finished loading. The declaration's resources are built once, by the first callback that needs them. A declaration with `sqs.bind(queue)` maps the queue when its resources are built.

So no module reads a binding of the other module while the cycle is still loading. Rolldown keeps `const` in the bundle, so a binding that is read too early throws a `ReferenceError`. esbuild turned `const` into `var`, so the same mistake gave `undefined` with no error.

## Resource graph construction

After compilation, the resource graph is built by dynamically importing the compiled infrastructure module:

```ts [packages/core/src/orchestrator/graph.ts]
return collectResourceGraph(
  async () => {
    await import(`${outFilePath}?${Date.now()}`);
  },
  { scope, declarationChecks: opts.declarationChecks },
);
```

While the compiled entry is imported, calls such as `queue({ ... })` add resources to the graph. When the import ends, the `onEvaluationEnd` callbacks run. Each `$lambda` declaration then adds its Lambda function and the resources that support it (IAM role, log group, zip package), with `code` pointing at `dist/<module path>/index.mjs`. Then each wiring call adds its event source mapping, route or rule.

`scope` holds the app and the stage of the deployment. Resource constructors call `scopedPhysicalName` from `@notation/resource`, which reads `scope` and returns the name `<app>--<stage>--<id>`. `notation viz` deploys nothing, so it passes no scope, and the names in its graph are the bare IDs.

The reconciler uses the resulting `{ resources, resourceGroups }` object to plan deployments.

## Watch mode compilation

In watch mode (`notation watch`), both passes run in Rolldown's `watch()`. Changes to source files trigger incremental rebuilds.

After each infra rebuild without errors, the CLI compares the declaration modules with the previous list. When the list changes, it closes the runtime watcher and starts one for the modules in the new list:

- **New declaration modules** – a module that infra starts to import, a new file that `files.runtime` matches, or a module that starts to call `$lambda`, gets its own runtime build.
- **Removed declaration modules** – a module that infra stops importing, or that stops calling `$lambda`, loses its runtime build. The reconciler deletes its resources.

Deploys need a successful build, so watch waits for the first infra build that succeeds. A change to the config file makes `notation watch` exit, so you restart it with the new config.
