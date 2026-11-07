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

The build doesn't read file names: it finds runtime modules by their call to `$lambda`. `runtime/utils.ts` makes no such call, so it is an ordinary module. Runtime modules can import ordinary modules, and Notation bundles the shared code into each function that imports it.

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

A shared module is an ordinary module that both files import, such as `runtime/utils.ts`.

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
scratch.ts matches runtimeModules, but it can't be analysed: Unexpected token
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

The runtime build leaves infra modules out of the function's bundle. An infra module is a module that calls a resource function, such as `queue()` or `api()`, at its top level. If an infra module stays in the bundle, the build fails and names the chain of imports. Put code that infra and runtime share, such as a schema, in a module that declares no resources.
