# File Conventions

Notation uses a few conventions to decide how modules are compiled and deployed.

## Directory layout

```sh
my-app/
├── infra/             # Infrastructure definitions
│   └── api.ts         # Entry file
├── runtime/           # Lambda function code
│   ├── todos.ts       # Runtime module: declares a Lambda, exports handler
│   └── utils.ts       # Shared runtime utilities
├── dist/              # Compiled output (generated)
├── .notation/         # State (generated)
├── notation.config.ts # Project config: app, entry, default stage
├── package.json
└── tsconfig.json
```

## Module kinds

The build sorts each module into one of three kinds by the module's own code. The kind decides what each build does with the module.

| Kind    | A module of this kind                                                       | Infra build                | Runtime build (the function's bundle)                             |
| ------- | --------------------------------------------------------------------------- | -------------------------- | ----------------------------------------------------------------- |
| Runtime | calls a declaration function, such as `$lambda`                             | keeps only the declaration | keeps the code, and strips the declaration to its runtime options |
| Infra   | calls a resource function, such as `queue()`, at its top level              | bundles it as written      | leaves it out unless the function uses its exports                |
| Shared  | is neither of the above, such as a schema, a constant, a helper or a barrel | bundles it as written      | bundles it as written                                             |

The build reads the kind from the code, not from the file's path or name. For example, in this project:

```ts [infra/orders.ts]
import { queue } from "@notation/aws/sqs";
export const orderQueue = queue({ name: "orders" });
```

```ts [infra/index.ts]
export * from "./orders";
```

```ts [lib/queues.ts]
import { queue } from "@notation/aws/sqs";
import { orderQueue } from "../infra/orders";
export const makeQueue = (name: string) => queue({ name });
export const ordersUrl = () => orderQueue.url;
export const label = (id: string) => `order-${id}`;
```

- `infra/orders.ts` is an infra module, because it calls `queue()` when it loads.
- `infra/index.ts` is a shared module. It only re-exports `infra/orders.ts`.
- `lib/queues.ts` is a shared module too. It calls `queue()` only inside a function, and it reads `orderQueue` only inside a function.

**Imports don't change a module's kind.** A module that imports an infra module, or imports a resource function, keeps the kind of its own code. A runtime module is the usual example: it imports infra to read values for its declaration, and the runtime build removes those uses.

So the rule for the function's bundle is about uses, not modules. Any module can import infra, as long as the function's bundle doesn't keep that use:

1. The runtime build marks each infra module free of side effects.
2. The bundler drops the imports and exports that the function doesn't use. An infra module that nothing in the bundle uses is dropped with them.
3. The build fails if an infra module, or a resource function from a package, is still in the bundle. See [Runtime code and infra](#runtime-code-and-infra).

For example, a function that calls `label()` from `lib/queues.ts` bundles `label`. The bundler drops `makeQueue` and `ordersUrl`, and with them `queue` and `infra/orders.ts`. A function that calls `ordersUrl()` fails the build, because the bundle keeps `infra/orders.ts`.

A module with a declaration is a runtime module, even if it also calls a resource function at its top level.

The rule applies to every file outside `node_modules`, including the files of a workspace package that resolve to a path outside the project root. If infra imports a runtime module in a workspace package, the build deploys its function and strips it from the infra bundle.

### Project modules

`sharedModules` matches only project modules, and its check follows imports only through project modules. Every file under the project root that isn't in `node_modules` is a project module, even in a folder with its own `package.json`. So in a monorepo with `notation.config.ts` at the repository root, `packages/api/handler.ts` is a project module.

A file outside the project root is a project module unless its nearest `package.json` with a `name` is in a folder that doesn't contain the project root. For example, with the config in `apps/api/`, `common/schema.ts` is a project module when `common/` has no `package.json` of its own, and the files of the workspace package `packages/aws/` are not.

## Infrastructure modules

Location: `infra/*.ts`

An infrastructure module declares cloud resources. The entry file is the module that `notation.config.ts` names in `entry`:

```ts [notation.config.ts]
export default defineConfig({
  app: "my-app",
  entry: "infra/api.ts",
});
```

```ts [infra/api.ts]
import { api, router } from "@notation/aws/api-gateway";
import { lambda as todos } from "runtime/todos";

const todoApi = api({ name: "todo-api" });
const todoRouter = router(todoApi);
todoRouter.get("/todos", () => todos);
```

The CLI deploys the entry file, the modules that it imports, and the runtime modules in the `runtimeModules` globs. To deploy part of a project separately, give that part its own config. See [Project Config](./project-config.md).

## Runtime modules

A runtime module holds the code of one deployed function, and declares that function. A module is a runtime module when it calls a declaration function, such as `$lambda` from `@notation/aws/lambda`:

```ts [runtime/todos.ts]
import { $lambda, http, type LambdaHandler } from "@notation/aws/lambda";
import { api } from "./utils";

export const lambda = $lambda({
  id: "todos",
  timeout: 5,
  memory: 64,
  event: () => http(),
});

const todos = await api.get<any[]>("/todos");

export const handler: LambdaHandler<typeof lambda> = async () => todos;
```

The module has two parts:

1. **The declaration**, `lambda`. It describes the function: its ID, its events, its settings and the values it reads. See [Lambda Declaration](./function-config.md).
2. **The entry**, `handler`. Lambda calls it with each event. See [Lambda Handlers](./functions.md).

**Each runtime module deploys as one function.** A module can hold one declaration, and must export the entry that the platform calls. For a Lambda the entry is `handler`. A module with two declarations, or a Lambda module with no `handler` export, fails the build.

The build doesn't read file names: it finds runtime modules by their call to `$lambda`. `runtime/utils.ts` makes no such call and declares no resources, so it is a shared module. Runtime modules can import shared modules, and Notation bundles the shared code into each function that imports it.

### Infra imports the declaration

Infra imports the declaration from a runtime module, and passes it to infra APIs as a function, such as `() => todos`:

```ts [infra/api.ts]
import { lambda as todos } from "runtime/todos";

todoRouter.get("/todos", () => todos);
todoRouter.get("/todos/count", () => todos);
```

Infra never imports `handler`. The declaration is the only value that crosses from the runtime module to infra.

Infra can import only the declaration from a runtime module, and the exports that the declaration uses. Any other import fails the build, such as a route path that is exported next to the handler:

```text
Illegal import: infra/routes.ts imports ROUTE from a runtime module, runtime/orders.ts. Move ROUTE to a shared module.
```

A shared module is a module that is neither a runtime module nor an infra module, such as `runtime/utils.ts`. Both files can import it. See [Module kinds](#module-kinds).

**The runtime module's code doesn't run at deploy time.** The infra build runs a stripped copy of `runtime/todos.ts`. The copy keeps the declaration and the top-level statements that the declaration uses. Everything else is removed, so the `api.get("/todos")` call above runs only in the Lambda function. See [Compiler](../internals/compiler.md#the-infra-build).

An effect that the declaration doesn't refer to by name is also removed. For example, if a side-effect import such as a `.env` loader sets a value that an option reads, the infra build doesn't run the import, and the option reads the value without it. `notation plan` shows the function's settings, so you can check them.

### Runtime modules that infra doesn't import

A runtime module doesn't have to be imported by infra to be deployed. For example, if `runtime/nightly-report.ts` declares a function with `$lambda` and nothing in infra imports it, the CLI still deploys the function.

`runtimeModules` in `notation.config.ts` sets the files that the build scans for runtime modules. It takes a glob or an array of globs, relative to the config. The default is `runtime/**/*.ts`.

```ts [notation.config.ts]
export default defineConfig({
  app: "todos",
  entry: "infra/index.ts",
  runtimeModules: ["runtime/**/*.ts", "jobs/*.ts"],
});
```

The build reads each file that matches the globs. A file that calls a declaration function, such as `$lambda`, is a runtime module, and the CLI deploys it. The infra bundle runs the infra entry first, and then each runtime module that the entry didn't import.

**A runtime module outside these globs is deployed only if infra imports it.** The build doesn't scan other files.

The build doesn't run a file in the globs that makes no declaration, such as `runtime/utils.ts`. The scan skips `dist/`, `node_modules/` and dot-directories at any depth.

**A file in the globs that can't be parsed fails the build**, even if nothing imports it. For example, with `**/*.ts`, a scratch file with a syntax error fails the deploy:

```text
scratch.ts matches runtimeModules, but it can't be analysed: /project/scratch.ts: Unexpected token
```

### Runtime code and infra

A runtime module imports infra to read values for its declaration, such as a queue's URL in `env`. The function's own code can't use infra directly:

```ts [runtime/orders.ts]
import { $lambda, sqs, type LambdaHandler } from "@notation/aws/lambda";
import { orderQueue } from "infra/orders";

export const lambda = $lambda({
  id: "orders",
  event: () => sqs(),
  env: () => ({ ORDER_QUEUE_URL: orderQueue.url }), // ✔ bound by name
});

export const handler: LambdaHandler<typeof lambda> = async () => {
  console.log(lambda.env().ORDER_QUEUE_URL); // ✔ read through the declaration
  console.log(orderQueue.url); // ✘ fails the runtime build
};
```

The runtime build leaves infra modules out of the function's bundle. If the function's code uses an infra module, the build fails. The error names the chain of imports from the function's module to the infra module, and the position of the call that makes the module infra:

```text
The bundle of runtime/orders.ts includes the infra module infra/orders.ts. The bundle imports it through runtime/orders.ts → lib/queues.ts → infra/orders.ts, and uses orderQueue at lib/queues.ts:4:32. infra/orders.ts is an infra module because it calls queue at its top level (infra/orders.ts:2:27). ...
```

In this example, the function calls `ordersUrl()` from `lib/queues.ts`. The function can still use `label()` from the same module, because the bundler drops `ordersUrl` when nothing calls it. Put code that infra and runtime share, such as a schema, in a module that declares no resources.

The runtime build leaves an infra module out even when a runtime module imports it only for its side effects, as in `import "../infra/orders"`. The top-level code of an infra module declares resources, so it doesn't run in the function. A shared module that imports infra, such as a setup module that sets a global and reads a queue's URL in one of its functions, keeps its top-level code in the function.

## Shared modules

The build infers that a module is shared when it declares no function and no resources. A module that imports infra is still shared, so the function can use its other exports. The build reports an error only where the function's bundle keeps infra, as in the example above.

`sharedModules` in `notation.config.ts` lists modules that must stay free of infra in both builds. It takes a glob or an array of globs, relative to the config, in the same forms as `runtimeModules`. A leading `./` is allowed:

```ts [notation.config.ts]
export default defineConfig({
  app: "orders",
  entry: "infra/index.ts",
  sharedModules: ["shared/**/*.ts"],
});
```

A module that matches `sharedModules` is checked when either build loads it. The build fails if the module, or a project module that it imports directly or through other project modules:

- calls a declaration function, such as `$lambda`,
- imports a resource function, such as `queue`, including through `export *` or a namespace import of a package,
- calls a resource function at its top level, such as a function marked `@resource` in the project.

The check stops at a file outside the project, such as a workspace package. That file fails the check only if it calls a declaration function, or calls a resource function at its top level. The check doesn't follow imports into `node_modules`.

An import that a module uses only in types doesn't count, with or without the `type` keyword. For example, `import { orderQueue } from "../infra/orders"` with only `typeof orderQueue` in the module passes, because TypeScript removes the import.

The error names the first problem in the listed module, and the shortest chain of imports to a module with a problem, with the position of each import:

```text
shared/format.ts:1:1: shared/format.ts matches sharedModules, but it imports lib/queues.ts, which imports the resource function queue from @notation/aws/sqs (lib/queues.ts:1:10). A shared module runs in both builds, so it can't declare a function or import a resource function, directly or through the modules that it imports.
```

**The check is stricter than the function's bundle.** `lib/queues.ts` is a shared module, and a function can use `label()` from it. A listed module that imports `lib/queues.ts` still fails, because `lib/queues.ts` imports `queue`. Listing a module is a promise that nothing it loads touches infra, whichever exports a build uses.

The build reads static imports and re-exports. It doesn't follow a dynamic `import()` or an `import x = require()`, so a listed module that loads infra that way passes the check. If the function then uses an infra module, the runtime build still fails.
