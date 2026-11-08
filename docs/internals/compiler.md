# Compiler

The compiler builds two kinds of bundle with Rolldown: one infra bundle, which the CLI runs to collect the resource graph, and one runtime bundle for each function.

Source: `@notation/build` (plugins and source transforms), `@notation/cli` (`packages/cli/src/compile.ts`), `@notation/core`

## Two-pass compilation

`compile({ entryPoint, runtimeModules, sharedModules })` in `@notation/cli` runs two passes. Both passes share one `ModuleAnalyses`, which holds the `sharedModules` globs:

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

The infra pass also finds declaration modules that the entry doesn't import. The input of the infra build is not the entry file but a virtual module, `notation:infra-entry`, from `infraEntryPlugin` in `@notation/build`. Its `load` hook globs the files in `runtimeModules`, analyses each one, and imports the entry and then each file that holds a declaration:

```ts [notation:infra-entry]
import "/project/infra/index.ts";
import "/project/runtime/nightly-report.ts";
import "/project/runtime/todos.ts";
```

The output keeps the entry's name, such as `dist/infra/index.mjs`. `runtime/todos.ts` is imported by the entry as well, but an ES module runs once, so the second import does nothing. `infraPlugin` then strips each of these modules as usual.

**The generated entry imports only files that hold a declaration.** A runtime file without one, such as a file that calls `Sentry.init()`, doesn't run at deploy time.

In watch mode, the plugin adds the base directory of each glob to the watched files, such as `runtime/` for `runtime/**/*.ts`. A new file in that directory starts a rebuild, and the `load` hook globs the files again. If the base directory doesn't exist yet, the plugin watches its nearest parent that exists, up to the project root, so a `runtime/` directory created during watch is seen.

The base directory of a glob such as `**/*.ts` is the project root, so the watcher would see each build's output in `dist/` and each deploy's writes to `.notation/`. **Both would start another build, and in `notation watch` another deploy.** So the scan and the infra watcher skip the same directories at any depth: `dist/`, `node_modules/` and dot-directories. `infraWatchExclude` holds the watcher's globs.

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

```ts [packages/aws/src/lambda/declaration.ts]
/** @runtime schema */
export function sqs(schema) {
  /* ... */
}
```

```ts [packages/aws/src/sqs/queue.ts]
/** @resource */
export function queue(config) {
  /* ... */
}
```

| Mark           | Marks                                                  | Clauses                                                                                                                                                                                                                                             |
| -------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@declaration` | A function that declares a function resource           | `shared:` options that both builds keep. `runtime:` options that only run in the function. `keys:` kept options whose value returns an object literal, of which the runtime build keeps only the keys. `entry:` the export that the platform calls. |
| `@runtime`     | A function that builds part of a declaration's options | The names of the parameters that the runtime build keeps.                                                                                                                                                                                           |
| `@resource`    | A function that declares a resource                    | None.                                                                                                                                                                                                                                               |

The tags are in JSDoc because Rolldown and tsdown keep JSDoc comments in a package's `dist`, and drop other block comments.

`Marks` in `packages/build/src/marks.ts` resolves the marks of a module's imports. For each import, it resolves the specifier with Rolldown's resolver, the `node`, `import` and `default` conditions, and the nearest tsconfig's `paths`. Then it reads the target module and follows `export { x } from`, `export * from` and `export { x }` of an import, to the module whose function has the mark. A function that is declared under one name and exported under another, as tsdown emits it in a shared chunk, keeps its mark. Each module is parsed once, with Rolldown's `parseSync`, until it changes.

## Module analysis

`analyzeModule` in `packages/build/src/analyze.ts` reads three facts from each module outside `node_modules`:

1. **The declaration**, if the module has one. Every reference to a function marked `@declaration` must be a call written `const name = fn({ ... })` at the top level, with one object literal that has no spread, computed keys or accessors. Any other reference fails the build with its file and line. A module with two declarations fails too. The analysis records the declaration's binding, its call, and its options by key.
2. **The first call to a resource function at the top level**, outside any function, as `resourceCall`. A module with such a call is an infra module. See [Module kinds](#module-kinds).
3. **The first resource function that the module imports**, as `resource`, if it imports one. Only the [shared-module check](#the-shared-module-check) uses it. A named or default import counts, and so do `export { queue } from` and `export * from` a module that exports a resource function. A namespace import counts through the members that the module uses, such as `sqs.queue`, or when the module uses the namespace itself as a value. The module doesn't have to call the function, but it must use the import as a value. An import that the module uses only in types, such as `typeof queue`, doesn't count, because TypeScript removes it. The analysis names the function by its exported name, so `import { queue as makeQ }` gives `queue`.

A reference inside a function that is itself marked `@declaration` in the same module is skipped. This lets a user write a wrapper around `$lambda` and mark the wrapper.

`ModuleAnalyses` in `packages/build/src/modules.ts` keeps one analysis for each file, shared by both passes, and drops it when the file changes.

## Module kinds

`ModuleAnalyses.kind(file)` sorts a module into one of three kinds, as a `ModuleKind`, from the module's own analysis:

```ts [@notation/build]
type ModuleKind =
  | { kind: "runtime"; declaration: string } // such as "$lambda"
  | { kind: "infra"; call: string; start: number } // calls queue at its top level
  | { kind: "shared" };
```

1. A module with a declaration is runtime.
2. A module with a `resourceCall` is infra.
3. Any other module is shared.

**A module's imports don't change its kind.** A module that imports `orderQueue` for one of its functions is shared, and so is a barrel with `export * from "./orders"`, and a factory that calls `queue()` only inside a function. The runtime build doesn't need these modules to be infra: the bundler drops the uses that the function doesn't keep, and the bundle check fails on the uses that it does keep. See [Leaving infra out](#leaving-infra-out).

The rule is the same for every file outside `node_modules`, including the files of a workspace package, which resolve to their real path outside `node_modules`. The kind needs no walk of the module graph, so `kind` doesn't cache it. It reads the cached analysis.

`describeKind(file)` turns the kind into text for errors, such as `an infra module because it calls queue at its top level (infra/orders.ts:2:27)`.

**`sharedModules` and the shared-module check apply only to project modules.** `isProjectModule` leaves out a file in `node_modules`. Every other file under the project root is a project module, even in a folder with its own `package.json`, such as `packages/api/` in a monorepo whose config is at the repository root. A file outside the project root is left out when its nearest `package.json` with a `name` is in a directory that doesn't contain the project root. A workspace package resolves to its real path, such as `packages/aws/dist/sqs/index.js` for a project in `examples/sqs`, so the `node_modules` test alone doesn't catch it.

### The shared-module check

`ModuleAnalyses.checkShared(file)` runs in the `transform` hook of both plugins, for each module that `sharedModules` matches. It is the only part of the build that walks imports. The walk is breadth-first, from the listed module, along static imports and re-exports, including side-effect imports such as `import "./orders"` and `export {} from "./orders"`:

1. The walk leaves out imports whose specifiers are all `type`, and imports whose bindings the module uses only in types, such as `import { orders } from "./orders"` with only `typeof orders`. TypeScript removes such imports. A JSX tag counts as a use of a binding only if its name is capitalised, such as `<View />`, or is a member expression, such as `<ui.View />`, since TypeScript treats a lowercase tag as an intrinsic element.
2. A project module fails the check if it has a declaration, a `resource` or a `resourceCall`.
3. A file outside the project, such as a file of a workspace package, ends the walk. It fails the check only if it has a declaration or a `resourceCall`, which are the tests for its kind. The walk doesn't follow an import into `node_modules`.

The error names the first problem in the listed module, in source order: its own declaration or resource import, or the first import that leads to a module with a problem. For an import, it names the shortest chain to that module, with the position of each import:

```
shared/format.ts:1:1: shared/format.ts matches sharedModules, but it imports lib/queues.ts, which imports the resource function queue from @notation/aws/sqs (lib/queues.ts:1:10). ...
```

The walk doesn't follow a dynamic `import()` or an `import x = require()`. A module that `sharedModules` doesn't match is never checked.

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
  event: () => sqs(),
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
    event: () => sqs(),
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
export const lambda = $lambda({
  id: "orders",
  event: () => sqs(Order),
  policy: () => [refundQueue.grant(["SendMessage"])],
  env: () => ({ ORDER_QUEUE_URL: orderQueue.url }),
});
```

```ts [runtime build]
export const lambda = $lambda({
  id: "orders",
  event: () => sqs(Order),
  env: () => ({ ORDER_QUEUE_URL: undefined }),
});
```

::

1. Options that the mark lists under neither `shared:` nor `runtime:` are removed. For `$lambda`, `policy`, `runtime`, `timeout` and `memory` go. `id` stays, so the function can read `lambda.id`.
2. Each `keys:` option keeps the keys of the object that it returns, and each value becomes `undefined`. The option must be `() => ({ ... })`, or a function whose body is one `return { ... }`, with no spread or computed keys.
3. A call to a function marked `@runtime`, such as `sqs(Order)`, keeps its runtime arguments. The others become `undefined`.
4. An import whose uses the strip removed is removed too. For example, the import of `orderQueue` goes once its use in `env` is gone. An import that had no uses to begin with stays, because it may be there for its side effects, such as a polyfill.
5. The binding and its export stay, so an infra module that imports `lambda` still links.

The strip then checks the kept options. A reference to an import from an infra module, or a call to a resource function, fails the build with its file and line. For an infra module, the error says why the module is infra:

```
runtime/orders.ts:11:22: an option of $lambda that the function keeps refers to orderQueue, from infra/orders.ts, which is an infra module because it calls queue at its top level (infra/orders.ts:2:27). The runtime build removes infra. Read infra values in the function through the declaration's env().
```

The advice depends on where the name is defined. The strip follows the import through re-exports to the module that defines the name. If that module is shared, such as `runtime/schema.ts` for an `Order` that `infra/orders.ts` re-exports, the error advises importing the name from that module. Otherwise it advises `env()`.

### Leaving infra out

An import loads its module and runs the module's top-level code, even when nothing uses the import's bindings. So step 4 of the strip is what keeps `infra/orders.ts` out of the bundle of `runtime/orders.ts`. The TypeScript transform removes an unused import by default, but with `verbatimModuleSyntax` it keeps every import that isn't `import type`, so the strip doesn't rely on it.

An infra module can also be reached through a module that the strip doesn't change, such as a shared module that imports `orderQueue` and uses it in a function the handler never calls. For that case, the runtime plugin marks each infra module free of side effects, through the `moduleSideEffects` result of its `transform` hook. The bundler then drops the infra module if nothing in the bundle uses its bindings. Other modules keep their side effects, so a shared module that imports infra still runs its top-level code in the function. A module that calls `queue()` through a factory of its own, such as `makeQueue("orders")`, is not marked, so in this case the bundler keeps it, and the package check below fails the build.

The provider packages declare `"sideEffects": false` in their `package.json`, so the bundler also drops a package module whose exports the function doesn't use.

In `generateBundle`, the plugin checks that no infra module is left in the bundle. A handler that reads `orderQueue.url` directly keeps `infra/orders.ts` in the bundle, and the build fails:

```
The bundle of runtime/orders.ts includes the infra module infra/orders.ts. The bundle imports it through runtime/orders.ts → infra/orders.ts, and uses orderQueue at runtime/orders.ts:15:31. infra/orders.ts is an infra module because it calls queue at its top level (infra/orders.ts:2:27). The runtime build leaves infra modules out, so runtime code can't use them. ...
```

If several infra modules are left, the error names the one with the shortest chain of imports from the function's module. One breadth-first walk of the module graph from the entry finds it. The chain follows static and dynamic imports. The error names that chain, then lists each reference to an import from the infra module, in any project module in the bundle. References in the declaration's options are left out, because the strip has removed or checked them. The list can include a reference in code that tree-shaking dropped, since the module is in the bundle either way. If the plugin finds no reference, such as for an `export { orderQueue } from "../infra/orders"`, the error names only the chain. Last, the error says why the module is infra, from `describeKind`.

The plugin also checks infra functions from packages. `sideEffects: false` only drops what the function doesn't use, so a handler that calls `queue()` from `@notation/aws/sqs` would bundle it, with the AWS SDK. For each package module in the bundle, the plugin looks up the mark of each export that is left after tree-shaking. An export marked `@resource` or `@declaration` fails the build. The error names the chain of imports to the package module and each reference to the export, such as `queue at infra/helpers.ts:4:10`. This check also catches an infra module that calls a resource function through a factory, because the chain passes through the module that calls the factory. `$lambda` from the runtime entry of `@notation/aws/lambda` has no mark, so it passes.

## Import cycles

A runtime module imports infra for its options, and infra imports the runtime module to wire it, so the two modules often import each other. Two rules keep the cycle safe:

1. Options that refer to infra are functions, such as `env: () => ({ ... })`, and infra passes declarations as functions, such as `() => lambda`.
2. `$lambda` and the wiring calls, `queue.consume()`, `route()` and `schedule()`, register callbacks with `onEvaluationEnd` from `@notation/resource`. The callbacks run when infra has finished loading. The declaration's resources are built once, by the first callback that needs them.

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

- **New declaration modules** – a module that infra starts to import, a new file in the `runtimeModules` globs, or a module that starts to call `$lambda`, gets its own runtime build.
- **Removed declaration modules** – a module that infra stops importing, or that stops calling `$lambda`, loses its runtime build. The reconciler deletes its resources.

Deploys need a successful build, so watch waits for the first infra build that succeeds. A change to the config file makes `notation watch` exit, so you restart it with the new config.
