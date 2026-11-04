# Compiler

The compilation pipeline uses esbuild with custom plugins to produce deployable infrastructure and runtime bundles.

Source: `@notation/esbuild-plugins`, `@notation/core`

## Two-pass compilation

Notation compiles the project in two passes:

1. **Infrastructure pass** – bundles the infra entry point with `infraPlugin`. Evaluating the bundle produces the resource graph.
2. **Runtime pass** – bundles each runtime module that the infra pass replaced, as the code for one function. The bundles build at the same time.

The infra pass determines what infrastructure resources should be provisioned; the runtime pass produces the code artefacts that run on them.

## Runtime modules

A file is a runtime module when it matches a `runtimeModules` glob and exports `resource`. Only the infra pass applies this rule. It reports the runtime modules that it replaced, and the runtime pass bundles those and no others, so the two passes can't disagree.

| Function                             | Package                     | Does                                                                                               |
| ------------------------------------ | --------------------------- | -------------------------------------------------------------------------------------------------- |
| `resolveRuntimeModules(config)`      | `@notation/core`            | Returns the config's globs as an array, or the default `["**/*.fn.ts"]`                            |
| `matchesRuntimeModules(path, globs)` | `@notation/esbuild-plugins` | Checks a path against the globs with `minimatch`. Paths in `node_modules/` and `dist/` never match |
| `parseRuntimeModule(source, path)`   | `@notation/esbuild-plugins` | Reads `resource` and the export names, or returns `undefined` if there is no `resource`            |

`parseRuntimeModule` reads the source with the TypeScript parser and never runs it. So `resource` must be an object literal with literal values, and it must have a `service` and an `id`. The parser fails on:

- A `config` export in the old shape (an object literal with a `service` property) and no `resource` export. The error asks you to rename it. A `config` export of any other shape is ordinary code.
- A `service` that isn't in `supportedServices`. At present only `aws/lambda` is supported.
- A key that the service doesn't have, such as a misspelled `timout`. For `aws/lambda` the keys are `service`, `id`, `runtime`, `timeout` and `memory`. So `resource.code` also fails, because the compiler sets `code`.
- An `id` that isn't name-safe: 1 to 64 letters, digits, hyphens or underscores.
- `export default`, `export =`, `export *`, `export namespace` and `export import`. The generated module needs a name for each export.
- String export names, such as `export { a as "a-b" }`, and export names that start with `__notation`. The generated module declares each export as a `const`, and uses the `__notation` prefix for its own names.

## The infra plugin

`infraPlugin` is an esbuild plugin. During the infra pass, it replaces each runtime module that infra imports with a generated module. Files that match the globs but don't export `resource` load unchanged. After each build without errors, the plugin calls `onRuntimeModules` with the path and service of each module it replaced. `compileInfra` returns that list, and `compileRuntimeModules` bundles it.

### The transformation

::code-group

```ts [runtime/todos.fn.ts]
import { handle, json, type LambdaResource } from "@notation/aws/lambda.fn";

const todos = await fetchTodos();

export const getTodos = handle.apiRequest(() => json(todos));
export const createTodo = handle.apiRequest(async (req) =>
  json(await save(req)),
);

export const resource: LambdaResource = {
  service: "aws/lambda",
  id: "todos",
  timeout: 5,
  memory: 64,
};
```

```ts [generated module]
import { lambda as __notationFactory } from "@notation/aws/lambda";
const __notationResource = __notationFactory({
  id: "todos",
  code: { type: "file", path: "dist/runtime/todos.fn/index.mjs" },
  timeout: 5,
  memory: 64,
});
const __notationRef0 = { resource: __notationResource, export: "getTodos" };
export { __notationRef0 as getTodos };
const __notationRef1 = { resource: __notationResource, export: "createTodo" };
export { __notationRef1 as createTodo };
```

::

### How it works

1. `resource.service` has the form `<platform>/<service>`, and must be a supported service. The generated module imports the factory `<service>` from `@notation/<platform>/<service>`, so `"aws/lambda"` gives `lambda` from `@notation/aws/lambda`.
2. The generated module calls the factory once. It passes every field of `resource` except `service`, and adds `code`, which points at the runtime bundle.
3. For each other export, the generated module declares a reference, `{ resource, export: "<name>" }`, under a generated name, and exports it under the export's name. An export name such as `delete` is not a valid variable name, so the reference is not declared under the export's name.
4. The generated names start with `__notation`. The parser rejects export names with that prefix, so the two sets of names never clash.

**None of the runtime module's code is kept.** In the example, `fetchTodos()` runs only in the Lambda function, never at deploy time. The plugin also lists the runtime module in `watchFiles`, so watch mode rebuilds the infra bundle when the module's exports or `resource` change.

## The runtime entry

The runtime pass doesn't bundle the module directly. Its entry point is generated by `createRuntimeEntry`:

```ts [generated runtime entry]
import * as mod from "/path/to/my-app/runtime/todos.fn.ts";
import { createDispatcher } from "@notation/aws/lambda.fn";
export const handler = createDispatcher(mod);
```

The dispatcher comes from `@notation/<platform>/<service>.fn`. The bundle goes to `dist/<module path>/index.mjs`, so Lambda calls `index.handler`. `createDispatcher` sends each event to an export of the module; see [Dispatch](../resources/lambda.md#dispatch).

## Resource graph construction

After compilation, the resource graph is built by dynamically importing the compiled infrastructure module:

```ts [packages/core/src/orchestrator/graph.ts]
return collectResourceGraph(() => import(outFilePath), {
  scope: { app: deployment.app, stage: deployment.stage },
});
```

While the compiled entry point is imported, calls such as `lambda({ ... })` add the Lambda function and its associated resources (IAM role, log group, zip package) to the graph.

`scope` holds the app and the stage of the deployment. Resource constructors such as `lambda()` call `scopedPhysicalName` from `@notation/resource`, which reads `scope` and returns the name `<app>--<stage>--<id>`. `notation viz` deploys nothing, so it passes no scope, and the names in its graph are the bare IDs.

The reconciler uses the resulting `{ resources, resourceGroups }` object to plan deployments.

## Watch mode compilation

In watch mode (`notation watch`), esbuild runs in `context.watch()` mode for both passes. Changes to source files trigger incremental rebuilds.

After each infra rebuild, the CLI compares the replaced runtime modules with the previous list. When the list changes, it stops the runtime builds and starts one for each module in the new list:

- **New runtime modules** – a module that infra starts to import, or that starts to export `resource`, gets its own runtime build
- **Removed runtime modules** – a module that infra stops importing, or that stops exporting `resource`, loses its runtime build; the reconciler deletes its resources

A change to the config file makes `notation watch` exit, so you restart it with the new config.

Together this gives you a live development loop: save a file, and Notation recompiles, re-evaluates the graph, and deploys the diff.
