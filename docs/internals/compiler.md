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
  entry: string; // the export that the platform calls, such as "handler"
};
```

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

| Mark           | Marks                                        | Clauses                                                                                                                                                                                                                                                                                                                                |
| -------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@declaration` | A function that declares a function resource | `shared:` options that both builds keep. `runtime:` options that only run in the function. `keys:` kept options whose value returns an object literal, of which the runtime build keeps only the keys. `entry:` the export that the platform calls.                                                                                    |
| `@resource`    | A function that declares a resource          | `runtime:` options of the resource that a function reads when a kept option of a declaration names the resource, such as `schema` in `sqs.bind(orderQueue)`. `runtime:` with no options means the resource becomes `{}`, as `api()` does. A bare `@resource` can't be read in a function. See [The runtime strip](#the-runtime-strip). |

The tags are in JSDoc because Rolldown and tsdown keep JSDoc comments in a package's `dist`, and drop other block comments.

`Marks` in `packages/build/src/marks.ts` resolves the marks of a module's imports. For each import, it resolves the specifier with Rolldown's resolver, the `node`, `import` and `default` conditions, and the nearest tsconfig's `paths`. Then it reads the target module and follows `export { x } from`, `export * from` and `export { x }` of an import, to the module whose function has the mark. A function that is declared under one name and exported under another, as tsdown emits it in a shared chunk, keeps its mark. Each module is parsed once, with Rolldown's `parseSync`, until it changes.

## Module analysis

`analyzeModule` in `packages/build/src/analyze.ts` reads two facts from each project module:

1. **The declaration**, if the module has one. Every reference to a function marked `@declaration` must be a call written `const name = fn({ ... })` at the top level, with one object literal that has no spread, computed keys or accessors. Any other reference fails the build with its file and line. A module with two declarations fails too. The analysis records the declaration's binding, its call, and its options by key.
2. **The first call to a resource function at the top level**, outside any function, as `resourceCall`. The runtime strip uses it to fail a kept option that refers to a value from a file with no kind, and the bundle check uses it to say in an error how to leave the call out of the function. See [Package files](#package-files).

A reference inside a function that is itself marked `@declaration` in the same module is skipped. This lets a user write a wrapper around `$lambda` and mark the wrapper.

`ModuleAnalyses` keeps one analysis for each file, shared by both passes, and drops it when the file changes.

## The infra build

`infraPlugin` does two things:

- It leaves installed packages external, so the infra bundle imports them from the project's `node_modules`. A bare specifier that names no installed package, such as a tsconfig path alias like `runtime/todos`, is bundled.
- It replaces each declaration module with the output of `stripForInfra`.

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

function __notation_declaredIn(value, path, binding) {
  if (
    (typeof value === "object" && value !== null) ||
    typeof value === "function"
  ) {
    Object.defineProperty(value, Symbol.for("@notation/declaredIn"), {
      value: { path, binding },
    });
  }
  return value;
}
```

::

1. `Sentry.init()` and the `handler` are removed, so neither runs at deploy.
2. The declaration is wrapped in `__notation_declaredIn`, which records the module's path and the binding's name on the declaration's value, under `Symbol.for("@notation/declaredIn")`. `getDeclaredIn` in `@notation/resource` reads the same key. The helper is written into the module, so the user's project doesn't need to resolve `@notation/resource`. The path is relative to the project root, so the infra bundle is the same on every machine. The name `__notation_declaredIn` is reserved: a module that declares it fails the build.
3. Each option that the mark lists under `runtime:` is replaced with a function that throws. `$lambda` lists none.

The strip fails the build if the module doesn't export the mark's `entry`, such as `handler`. An entry that comes through `export * from` counts: `Marks.hasExport` follows the star exports to the module that declares it.

The plugin also fails the build if a module imports a name from a declaration module that the stripped copy doesn't export. For each named import and `export { x } from` of a project module, it resolves the specifier with `Marks`, and asks `infraInterface` for the exports that the target's stripped copy keeps. In a declaration module, only the imports that the stripped copy keeps are checked. Without this check, Rolldown reports a missing export, which doesn't say why the export is missing. A namespace import, such as `import * as orders`, isn't checked. In watch mode, only the modules that changed are transformed again. If a change to a declaration module removes an export that another module imports, the error comes from Rolldown.

**An effect that the declaration doesn't name is lost.** A side-effect import, a mutation such as `settings.memory = 2048`, or a `.env` loader doesn't run in the infra build, even when an option reads the value that it sets.

### Recording the declaration modules

The plugin records a `DeclarationModule` for each module that it strips. In `generateBundle`, it keeps the modules that are in the finished bundle, sorts them by path, and calls `onDeclarationModules`. `compileInfra` returns that list.

## The runtime build

`compileRuntimeModules` builds one bundle for each declaration module, to `dist/<module path>/index.mjs`, as one file with no code splitting. The build resolves packages with the conditions `notation-runtime`, `node`, `import` and `default`. Through `notation-runtime`, `@notation/aws/lambda` resolves to `dist/lambda/runtime.js`, which has the same exports as the infra entry and none of the infra code. Its `$lambda` returns a declaration with `env()` and `decode()`, and builds no resources.

### The entry

The bundle's entry is generated by `createRuntimeEntry`. It re-exports only the module's entry:

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

export const lambda = $lambda({
  id: "orders",
  event: () => sqs.bind({ schema: __notation_schema_0 }, undefined),
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

1. Options that the mark lists under neither `shared:` nor `runtime:` are removed. For `$lambda`, `policy`, `runtime`, `timeout` and `memory` go. `id` stays, so the function can read `lambda.id`.
2. Each `keys:` option keeps the keys of the object that it returns, and each value becomes `undefined`. The option must be `() => ({ ... })`, or a function whose body is one `return { ... }`, with no spread or computed keys.
3. In a kept option, a resource from an infra module is replaced with the resource's runtime options, wherever it appears. See [Resource arguments](#resource-arguments).
4. An import whose uses the strip removed is removed too. For example, the import of `orderQueue` and `refundQueue` goes once their uses in `event`, `policy` and `env` are gone. An import that had no uses to begin with stays, because it may be there for its side effects, such as a polyfill.
5. The binding and its export stay, so an infra module that imports `lambda` still links.

The strip then checks the kept options. A reference to an import from an infra module, or a call to a resource function, fails the build with its file and line. So does a reference to an import from a file with no kind outside `node_modules/` that calls a resource function at its top level, such as `dlq` in `event: () => sqs.bind(dlq)`. This includes a file of a workspace package or a package folder. The function can't load that file, and adding it to `files.infra` gives the error for an infra module. So both errors say to move a plain value that a kept option uses to a shared module, or to a file with no kind.

### Resource arguments

`sqs.bind(orderQueue)` names a queue, but the function needs only the queue's schema, and the function can't load `infra/orders.ts`. So step 3 of the strip replaces the argument with an object of the queue's runtime options: `sqs.bind({ schema: __notation_schema_0 })`.

`sqs.schema(Order)` names no resource, so the strip leaves it as it is. `Order` comes from a shared module, which the function loads.

The replacement doesn't depend on where the resource appears in the option. `apiGateway.bind(userApi).defineRoute({ method: "GET", path: "/user", schema: null, auth: userAuth })` becomes `apiGateway.bind({}).defineRoute({ method: "GET", path: "/user", schema: null, auth: { claims: __notation_claims_0 } })`. `userApi` becomes `{}` because `api()` is marked `@resource runtime:` with no options, and `userAuth` becomes its claims because `jwtAuthorizer()` is marked `@resource runtime: claims`. The other options stay as they are, so a `schema` option other than `null` must come from a shared module.

The strip finds the options in four steps:

1. **An expression in a kept option names an import from an infra module.** The expression can be a name, such as `orderQueue`, or a member of an object literal or of a namespace import, such as `queues.orders` or `infra.orderQueue`. The strip replaces the whole member path, and doesn't replace the names in it on their own. Any other expression is left as it is.
2. **The strip follows the import to the resource.** It follows re-exports and imports to the `const` that the infra module exports, and member keys through object literals. A `let` or `var` is left as it is, because the module can assign another value to it, and it fails the build like any other reference to an infra module. The value must be a call to a function marked `@resource`, such as `queue({ ... })`. Any other value fails the build, because the strip can't read its options. The strip can't tell a resource that a helper or a loop makes from a plain value, such as a schema made by `v.object(...)`. So the error says to declare a resource with a call to its resource function, and to move a plain value to a shared module. A resource with a bare `@resource` mark is left as it is, and fails the build like any other reference to an infra module. A resource marked `@resource runtime:` with no options becomes `{}`.
3. **The strip reads each option that the mark lists after `runtime:`.** `queue` is marked `@resource runtime: schema`, so the strip reads the `schema` property of the call's object literal. The property's value must be a name that the infra module imports by name, or as a default import, from a shared module, a package, or a file with no kind. These are the files that the runtime build bundles as they are. A schema that the infra module defines, a member of a namespace import such as `schemas.Order`, and an expression such as `Order.extend({ ... })` fail the build, because the strip can only copy an import. A schema imported from an infra or runtime module fails the build too, because the function can't load it there. So does a schema imported from a file with no kind that calls a resource function at its top level, as for any other value from such a file.
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
The function in runtime/orders.ts uses infra/orders.ts, an infra module (files.infra: "infra/**", the default): orderQueue at runtime/orders.ts:15:31. It imports infra/orders.ts through runtime/orders.ts → infra/orders.ts. The runtime build leaves infra out, so runtime code can't use it. Read infra values through the declaration's env(). Move a plain value that the function needs, such as a constant, to a shared module (files.shared).
```

The error says why the module is infra, and lists each reference to an import from the infra module, in any project module in the bundle. Then it names the shortest chain of imports from the function's module to the infra module. References in the declaration's options are left out, because the strip has removed or checked them. The list can include a reference in code that tree-shaking dropped, since the module is in the bundle either way. If the plugin finds no reference, such as for an `export { orderQueue } from "../infra/orders"`, the error names only the chain.

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
