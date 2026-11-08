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

The build sorts each module of the project into one of three kinds. The kind decides what each build does with the module.

| Kind    | A module of this kind                                                      | Infra build                | Runtime build (the function's bundle)                             |
| ------- | -------------------------------------------------------------------------- | -------------------------- | ----------------------------------------------------------------- |
| Runtime | calls a declaration function, such as `$lambda`                            | keeps only the declaration | keeps the code, and strips the declaration to its runtime options |
| Infra   | imports a resource function, such as `queue()`, or imports an infra module | bundles it as written      | leaves it out                                                     |
| Shared  | is neither of the above, such as a schema, a constant or a helper          | bundles it as written      | bundles it as written                                             |

The build reads the kind from the code, not from the file's path or name. For example, in this project:

```ts [infra/orders.ts]
import { queue } from "@notation/aws/sqs";
export const orderQueue = queue({ name: "orders" });
```

```ts [infra/index.ts]
export * from "./orders";
```

```ts [shared/schema.ts]
import * as v from "valibot";
export const Order = v.object({ id: v.string() });
```

- `infra/orders.ts` is an infra module, because it imports `queue`.
- `infra/index.ts` is an infra module too, because it imports the infra module `infra/orders.ts`. **Infra is transitive:** a module that imports an infra module is an infra module, through any number of imports.
- `shared/schema.ts` is a shared module, because it imports neither a resource function nor an infra module.

The import is enough. A module that calls `queue()` only inside a function, such as a factory `makeQueue(name)`, is an infra module, and so is every module that imports the factory.

An import that a module uses only in types doesn't count, with or without the `type` keyword. For example, `import { orderQueue } from "../infra/orders"` with only `typeof orderQueue` in the module doesn't make the module infra, because TypeScript removes the import.

**A runtime module is never infra.** A runtime module usually imports infra to read values for its declaration, and the runtime build removes those imports. So the kind of a runtime module doesn't depend on its imports, and a module that imports a runtime module doesn't become infra through it.

The build doesn't follow imports into packages, so a module doesn't become infra through a package. An import of a resource function from a package, such as `queue` from `@notation/aws/sqs`, still makes the importing module infra.

Every file under the project root that isn't in `node_modules` is part of the project, even in a folder with its own `package.json`. So in a monorepo with `notation.config.ts` at the repository root, `packages/api/handler.ts` is part of the project. A file outside the project root is part of the project unless its nearest `package.json` with a `name` is in a folder that doesn't contain the project root. For example, with the config in `apps/api/`, `common/schema.ts` is part of the project when `common/` has no `package.json` of its own, and `packages/aws/` is a workspace package.

A file of a workspace package outside the project root, such as `packages/aws/`, is handled as it was before module kinds:

- A module that calls a declaration function is a runtime module. If infra imports it, the build deploys its function and strips it from the infra bundle.
- A module that calls a resource function at its top level is infra, and the runtime build leaves it out when the function doesn't use it.
- Any other module is shared. Its imports don't change its kind.

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

The build doesn't read file names: it finds runtime modules by their call to `$lambda`. `runtime/utils.ts` makes no such call and imports no infra, so it is a shared module. Runtime modules can import shared modules, and Notation bundles the shared code into each function that imports it.

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

The runtime build leaves infra modules out of the function's bundle. If the function's code uses an infra module, the build fails. The error names the chain of imports from the function's module, and the chain of imports that makes the module infra:

```text
The bundle of runtime/orders.ts includes the infra module runtime/format.ts. The bundle imports it through runtime/orders.ts → runtime/format.ts, and uses format at runtime/orders.ts:14:5. runtime/format.ts is an infra module because it imports infra/index.ts (runtime/format.ts:1:1), which imports infra/orders.ts (infra/index.ts:1:1), which imports queue from @notation/aws/sqs (infra/orders.ts:1:10). ...
```

In this example, `runtime/format.ts` imports `orderQueue` for one helper, so the whole module is infra, and the function can't use its other helpers either. Put code that infra and runtime share, such as a schema, in a shared module, and import infra only where infra is needed.

An import only for side effects, as in `import "./setup"`, depends on why the imported module is infra:

- If the module imports a resource function itself, such as `infra/alarms.ts` with `queue({ name: "dlq" })`, the runtime build leaves it out. Its top-level code declares resources, which must not run in the function.
- If the module is infra only through its imports, such as a setup module that also reads a queue's URL in one of its functions, the build fails. The runtime build would leave the module out, so its top-level code wouldn't run in the function. The error names the import and the chain that makes the module infra. Move the code that the function needs to run to a module that doesn't import infra.

## Shared modules

The build infers that a module is shared when it imports no resource function and no infra module. A module can stop being shared without any change to its own code, for example when a module that it imports starts to import infra. The build then reports an error where the function uses the module, as in the example above.

`sharedModules` in `notation.config.ts` lists the modules that must be shared. It takes a glob or an array of globs, relative to the config, in the same forms as `runtimeModules`. A leading `./` is allowed:

```ts [notation.config.ts]
export default defineConfig({
  app: "orders",
  entry: "infra/index.ts",
  sharedModules: ["shared/**/*.ts"],
});
```

A module that matches `sharedModules` is checked when either build loads it. The build fails if the module:

- calls a declaration function, such as `$lambda`,
- imports a resource function, such as `queue`,
- imports an infra module or a runtime module.

The error names the module, the line of the import, the imported module, and why that module is infra or runtime:

```text
shared/format.ts:2:1: shared/format.ts matches sharedModules, but it imports infra/orders.ts, which is an infra module because it imports queue from @notation/aws/sqs (infra/orders.ts:1:10). A shared module runs in both builds, so it can't declare a function or resources, or import an infra or runtime module.
```

The build reads static imports and re-exports. It doesn't follow a dynamic `import()` or an `import x = require()`, so a listed module that loads infra that way passes the check. If the function then uses the infra module, the runtime build still fails.

**`sharedModules` can't make an infra module shared.** A listed module that imports `queue` fails the build, whether it calls `queue()` or not.

A module that imports a listed module doesn't become infra through it, because the listed module is shared or the build fails.
