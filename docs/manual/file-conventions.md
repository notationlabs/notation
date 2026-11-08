# File Conventions

Notation uses a few conventions to decide how modules are compiled and deployed.

## Directory layout

```sh
my-app/
├── infra/             # Infrastructure definitions
│   └── api.ts         # Entry file
├── runtime/           # Lambda function code
│   ├── todos.ts       # Runtime module: declares a Lambda, exports handler
│   └── utils.ts       # Runtime module without a declaration
├── shared/            # Code that both builds run
│   └── schema.ts      # Shared module
├── dist/              # Compiled output (generated)
├── .notation/         # State (generated)
├── notation.config.ts # Project config: app, entry, default stage
├── package.json
└── tsconfig.json
```

Each of `infra/`, `runtime/` and `shared/` holds one kind of module. See [Module kinds](#module-kinds).

## Infrastructure modules

Location: `infra/**`, by default

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

The CLI deploys the entry file, the modules that it imports, and the runtime modules that `files.runtime` matches. To deploy part of a project separately, give that part its own config. See [Project Config](./project-config.md).

## Runtime modules

Location: `runtime/**`, by default

A runtime module holds the code of a deployed function. The module that declares the function calls a declaration function, such as `$lambda` from `@notation/aws/lambda`:

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

**Each module with a declaration deploys as one function.** A module can hold one declaration, and must export the entry that the platform calls. For a Lambda the entry is `handler`. A module with two declarations, or a Lambda module with no `handler` export, fails the build.

The build finds a declaration by the call to `$lambda`, not by the file name. `runtime/utils.ts` makes no such call, so it deploys no function. Notation bundles `runtime/utils.ts` into each function that imports it.

A declaration in a module that infra imports is found wherever the module is, even in a file that no glob matches. A declaration in an infra or shared module fails the build:

```text
infra/fn.ts:2:23: infra/fn.ts, an infra module (files.infra: "infra/**", the default), declares a function with $lambda. The runtime build leaves infra modules out, so it can't bundle the function. Move the declaration to a runtime module.
```

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

A shared module, such as `shared/routes.ts`, holds code that both infra and runtime modules import. See [Shared modules](#shared-modules).

**The runtime module's code doesn't run at deploy time.** The infra build runs a stripped copy of `runtime/todos.ts`. The copy keeps the declaration and the top-level statements that the declaration uses. Everything else is removed, so the `api.get("/todos")` call above runs only in the Lambda function. See [Compiler](../internals/compiler.md#the-infra-build).

An effect that the declaration doesn't refer to by name is also removed. For example, if a side-effect import such as a `.env` loader sets a value that an option reads, the infra build doesn't run the import, and the option reads the value without it. `notation plan` shows the function's settings, so you can check them.

### Runtime modules that infra doesn't import

A runtime module doesn't have to be imported by infra to be deployed. For example, if `runtime/nightly-report.ts` declares a function with `$lambda` and nothing in infra imports it, the CLI still deploys the function.

The build reads each file that `files.runtime` in `notation.config.ts` matches. The default is `runtime/**`. A file that calls a declaration function, such as `$lambda`, deploys as a function. The infra bundle runs the infra entry first, and then each of these modules that the entry didn't import.

```ts [notation.config.ts]
export default defineConfig({
  app: "todos",
  entry: "infra/index.ts",
  files: { runtime: ["runtime/**", "jobs/*.ts"] },
});
```

**A declaration outside these globs is deployed only if infra imports it.** The build doesn't scan other files.

The build doesn't run a file in the globs that makes no declaration, such as `runtime/utils.ts`. The scan skips `dist/`, `node_modules/` and dot-directories at any depth.

**A file in the globs that can't be parsed fails the build**, even if nothing imports it. For example, with `**/*.ts`, a scratch file with a syntax error fails the deploy:

```text
scratch.ts matches files.runtime, but it can't be analysed: /project/scratch.ts: Unexpected token
```

In watch mode, the CLI watches the folder of each `files.runtime` glob, such as `runtime/`. A new file in that folder starts a rebuild, and a new declaration deploys.

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

The runtime build leaves infra modules out of the function's bundle. An infra module is a file that `files.infra` matches, `infra/**` by default. If the function uses an infra module, the build fails, says why the module is infra, and names the chain of imports:

```text
The bundle of runtime/orders.ts includes infra/orders.ts, an infra module (files.infra: "infra/**", the default). The bundle imports it through runtime/orders.ts → infra/orders.ts, and uses orderQueue at runtime/orders.ts:12:15. The runtime build leaves infra out, so runtime code can't use it.
```

**Any module may import infra, as long as the function doesn't use that import.** For example, `runtime/format.ts` can import `orderQueue` for one export, and a function can use its other exports. The runtime build drops the infra module, and keeps the rest of `runtime/format.ts`, including its top-level code. Put code that infra and runtime share, such as a schema, in a shared module.

## Module kinds

The globs of `files` in `notation.config.ts` give each file its kind. The kind comes from the file's path only, so an edit to a file never changes its kind. See [Files](./project-config.md#files) for the globs.

| Kind      | Default folder | Infra build                       | Runtime build                                           |
| --------- | -------------- | --------------------------------- | ------------------------------------------------------- |
| `infra`   | `infra/`       | Runs it.                          | Leaves it out. The build fails if the function uses it. |
| `runtime` | `runtime/`     | Runs only the declaration of it.  | Bundles it.                                             |
| `shared`  | `shared/`      | Runs it as written.               | Bundles it as written.                                  |
| no kind   | any other file | Runs it, or only its declaration. | Bundles it as written.                                  |

### Shared modules

A shared module is code that both builds run, such as a schema that infra passes to `queue()` and the function reads:

```ts [shared/schema.ts]
import * as v from "valibot";

export const Order = v.object({ id: v.string() });
```

**Neither build strips a shared module, so the build checks that it is safe in both.** A shared module fails the build if it:

- declares a function, such as with `$lambda`,
- imports a resource function, such as `queue` from `@notation/aws/sqs`,
- imports an infra or runtime module, directly or through modules that aren't infra or runtime.

The error names the chain of imports, with the position of each import:

```text
shared/schema.ts:1:1: shared/schema.ts, a shared module (files.shared: "shared/**", the default), imports infra/orders.ts, an infra module (files.infra: "infra/**", the default), through shared/schema.ts:1:1 → lib/url.ts:1:1 → infra/orders.ts. Neither build strips a shared module, so it can't import an infra or runtime module, directly or through other modules.
```

The check follows the imports that load a module at runtime:

- `import { x } from`, when the module uses `x` as a value. TypeScript removes an import that is used only in types, so `import { type Order }` and `import type` don't count.
- `import "./setup"`, which loads the module for its side effects.
- `export { x } from` and `export * from`.

The check doesn't follow dynamic `import()`, and it doesn't enter packages.

### Files with no kind

A file that no glob matches, such as `lib/format.ts`, has no kind. Both builds bundle it as written, and the build makes no check of it. A declaration in such a file is still found and stripped when infra imports it.

**A file with no kind that calls a resource function at its top level stays in the function's bundle.** For example, `lib/queues.ts` with `export const dlq = queue({ name: "dlq" })` fails the runtime build if a function imports anything from it. To leave it out, add it to `files.infra`.

### Packages

A package file has no kind. Package files are:

- files in `node_modules/`,
- files outside the project root, such as a workspace package that resolves to its own folder,
- files under a folder below the root with a `package.json` that has a `name`, such as `packages/api/` in a monorepo, unless a glob matches them.

The runtime build treats a package file as infra if it calls a resource function at its top level. It drops such a file from the bundle when the function doesn't use it, and fails the build when the function does. A declaration in a package file outside `node_modules` is found and stripped when infra imports it.
