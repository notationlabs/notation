# File Conventions

Notation uses file naming conventions to determine how modules are compiled and deployed.

## Directory layout

```sh
my-app/
├── infra/             # Infrastructure definitions
│   └── api.ts         # Entry file
├── runtime/           # Lambda handler code
│   ├── todos.fn.ts    # Runtime module: exports resource
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
import { getTodos } from "runtime/todos.fn" with { type: "runtime" };

const todoApi = api({ name: "todo-api" });
const todoRouter = router(todoApi);
todoRouter.get("/todos", getTodos);
```

The CLI deploys the entry file and the modules that it imports. To deploy part of a project separately, give that part its own config. See [Project Config](./project-config.md).

## Runtime modules

Location: set by `runtimeModules` in `notation.config.ts`. The default is `**/*.fn.ts`.

A runtime module holds code that runs in a deployed resource, such as a Lambda function. A file is a runtime module when both of these are true:

1. The file matches one of the `runtimeModules` globs.
2. The file exports `resource`.

**Each runtime module deploys as one resource.** A module can export several handlers, and they all run in the same Lambda function, with the same bundle, role and settings.

```ts [runtime/todos.fn.ts]
import { handle, json, type LambdaResource } from "@notation/aws/lambda.fn";
import { api } from "./utils";

const todos = await api.get<any[]>("/todos");

export const getTodos = handle.apiRequest(() => json(todos));
export const getTodoCount = handle.apiRequest(() => json(todos.length));

export const resource: LambdaResource = {
  service: "aws/lambda",
  id: "todos",
  timeout: 5,
  memory: 64,
};
```

`resource.service` selects the type of resource. `"aws/lambda"` is the only service so far, and any other value fails the build. The other fields configure the resource; see [Lambda Resource](./function-config.md).

`runtime/utils.ts` doesn't match `**/*.fn.ts`, so it is an ordinary module. A file that matches a glob and has no `resource` export is also an ordinary module. Runtime modules can import ordinary modules. Notation bundles the shared code into each runtime module that imports it.

### Choosing the globs

`runtimeModules` takes one glob or an array of globs, relative to the config. For example, to treat every file in `runtime/` as a possible runtime module:

```ts [notation.config.ts]
export default defineConfig({
  app: "my-app",
  entry: "infra/api.ts",
  runtimeModules: "runtime/**",
});
```

With this setting, `runtime/utils.ts` matches the glob, but it has no `resource` export, so it stays an ordinary module. Files in `node_modules/` and `dist/` never match.

### Infra imports a runtime module

Infra code imports the handlers of a runtime module and passes them to infra APIs, such as `router.get`:

```ts [infra/api.ts]
import {
  getTodos,
  getTodoCount,
} from "runtime/todos.fn" with { type: "runtime" };

todoRouter.get("/todos", getTodos);
todoRouter.get("/todos/count", getTodoCount);
```

**The runtime module's code never runs at deploy time.** When the compiler builds the infra code, it replaces `runtime/todos.fn.ts` with a generated module. The generated module declares the Lambda function, and exports a reference for each export of the runtime module: `{ resource, export: "getTodos" }`. The `api.get("/todos")` call above runs only in the Lambda function. See [Compiler](../internals/compiler.md).

This applies to every export, not only handlers. If infra imports a constant or a helper from a runtime module, it gets a reference instead of the value, even though TypeScript types the import as the original value. Put code that infra and runtime share in an ordinary module.

If a file still exports the old `config` object (one with a `service` property) and no `resource`, the build fails with a message to rename the export. A `config` export of any other shape is ordinary code.
