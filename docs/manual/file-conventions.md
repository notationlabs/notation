# File Conventions

Notation uses a few conventions to decide how modules are compiled and deployed.

## Directory layout

```sh
my-app/
├── infra/             # Infrastructure definitions
│   └── api.ts         # Entry file
├── runtime/           # Lambda function code
│   ├── todos.fn.ts    # Runtime module: declares a Lambda, exports handler
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
import { lambda as todos } from "runtime/todos.fn";

const todoApi = api({ name: "todo-api" });
const todoRouter = router(todoApi);
todoRouter.get("/todos", () => todos);
```

The CLI deploys the entry file and the modules that it imports. To deploy part of a project separately, give that part its own config. See [Project Config](./project-config.md).

## Runtime modules

A runtime module holds the code of one deployed function, and declares that function. A module is a runtime module when it calls a declaration function, such as `createLambda` from `@notation/aws/lambda`:

```ts [runtime/todos.fn.ts]
import { createLambda, http, type LambdaHandler } from "@notation/aws/lambda";
import { api } from "./utils";

export const lambda = createLambda({
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

The `.fn.ts` ending is a naming convention. The build doesn't read file names: it finds runtime modules by their call to `createLambda`. `runtime/utils.ts` makes no such call, so it is an ordinary module. Runtime modules can import ordinary modules, and Notation bundles the shared code into each function that imports it.

### Infra imports the declaration

Infra imports the declaration from a runtime module, and passes it to infra APIs as a function, such as `() => todos`:

```ts [infra/api.ts]
import { lambda as todos } from "runtime/todos.fn";

todoRouter.get("/todos", () => todos);
todoRouter.get("/todos/count", () => todos);
```

Infra never imports `handler`. The declaration is the only value that crosses from the runtime module to infra.

**The runtime module's code doesn't run at deploy time.** The infra build runs a stripped copy of `runtime/todos.fn.ts`. The copy keeps the declaration and the top-level statements that the declaration uses. Everything else is removed, so the `api.get("/todos")` call above runs only in the Lambda function. See [Compiler](../internals/compiler.md#the-infra-build).

An effect that the declaration doesn't refer to by name is also removed. For example, if a side-effect import such as a `.env` loader sets a value that an option reads, the infra build doesn't run the import, and the option reads the value without it. `notation plan` shows the function's settings, so you can check them.

### Runtime modules must be imported

**The CLI deploys a runtime module only when the infra entry imports it, directly or through other modules.** If nothing in infra imports the module, Notation doesn't deploy its function and reports no error.

`notation.config.ts` accepts `runtimeModules`, a glob or an array of globs for the files that can be runtime modules. The default is `**/*.fn.ts`. The plan is that deploy scans these files for runtime modules that infra doesn't import. That scan isn't built, and the build doesn't read `runtimeModules` yet.

### Runtime code and infra

A runtime module imports infra to read values for its declaration, such as a queue's URL in `env`. The function's own code can't use infra directly:

```ts [runtime/orders.fn.ts]
import { createLambda, sqs, type LambdaHandler } from "@notation/aws/lambda";
import { orderQueue } from "infra/orders";

export const lambda = createLambda({
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
