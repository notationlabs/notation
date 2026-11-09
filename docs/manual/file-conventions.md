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

const todoApi = api({ id: "todo-api" });
const todoRouter = router(todoApi);
todoRouter.get("/todos", () => todos);
```

The CLI deploys the entry file, the modules that it imports, and the runtime modules that `files.runtime` matches. To deploy part of a project separately, give that part its own config. See [Project Config](./project-config.md).

## Runtime modules

Location: `runtime/**`, by default

A runtime module holds the code of a deployed function. The module that declares the function calls a declaration function, such as `$lambda` from `@notation/aws/lambda`:

```ts [runtime/todos.ts]
import { $lambda, apiGateway, type LambdaHandler } from "@notation/aws/lambda";
import { api } from "./utils";

export const lambda = $lambda({
  id: "todos",
  timeout: 5,
  memory: 64,
  event: () => apiGateway.schema(null),
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

**The runtime module's code doesn't run at deploy time.** The infra build runs a stripped copy of `runtime/todos.ts`. The copy keeps the declaration and the top-level statements that the declaration uses. Everything else is removed, so the `api.get("/todos")` call above runs only in the Lambda function.

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
  event: () => sqs.bind(orderQueue),
  env: () => ({ ORDER_QUEUE_URL: orderQueue.url }), // ✔ bound by name
});

export const handler: LambdaHandler<typeof lambda> = async () => {
  console.log(lambda.env().ORDER_QUEUE_URL); // ✔ read through the declaration
  console.log(orderQueue.url); // ✘ fails the runtime build
};
```

The runtime build leaves infra modules out of the function's bundle. An infra module is a file that `files.infra` matches, `infra/**` by default. If the function uses an infra module, the build fails, says why the module is infra, and names the chain of imports:

```text
The function in runtime/orders.ts uses infra/orders.ts, an infra module (files.infra: "infra/**", the default): orderQueue at runtime/orders.ts:12:15. It imports infra/orders.ts through runtime/orders.ts → infra/orders.ts. The runtime build leaves infra out, so runtime code can't use it. Read infra values through the declaration's env(). Move a plain value that the function needs, such as a constant, to a shared module (files.shared).
```

**An infra module never runs in the function, even if it calls no resource function.** A function that uses a plain constant from `infra/config.ts` fails the build. Put a value that the function needs in a shared module, or in a file that no glob matches.

**A setup module under `infra/` doesn't run in the function either.** For example, `infra/setup.ts` sets a global, and `runtime/orders.ts` imports it with `import "../infra/setup"`. The runtime build leaves `infra/setup.ts` out, and the build doesn't fail. The global isn't set in the function. Move code that the function needs to a shared module, or to a file that no glob matches.

**A runtime module, or a file with no kind, may import a value from an infra module, as long as the function doesn't use that value.** For example, `runtime/format.ts` can import `orderQueue` for one export, and a function can use its other exports. The runtime build drops the infra module, and keeps the rest of `runtime/format.ts`, including its top-level code. A shared module may not import an infra module. Put code that infra and runtime share, such as a schema, in a shared module.

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

**Neither build strips a shared module, so the build checks that it is safe in both.** A shared module that either build includes fails the build if it:

- declares a function, such as with `$lambda`,
- imports a resource function, such as `queue` from `@notation/aws/sqs`,
- imports an infra or runtime module, directly or through modules that aren't infra or runtime.

The error names the chain of imports, with the position of each import:

```text
shared/schema.ts, a shared module (files.shared: "shared/**", the default), imports infra/orders.ts, an infra module (files.infra: "infra/**", the default), through shared/schema.ts:1:1 → lib/url.ts:1:1 → infra/orders.ts. Neither build strips a shared module, so it can't import an infra or runtime module, directly or through other modules. Move the code that needs infra/orders.ts out of the shared module, or stop importing it through lib/url.ts.
```

A shared module that nothing imports isn't checked.

In watch mode, each build that includes a broken shared module fails and writes no bundle, so `notation watch` doesn't deploy it. The CLI prints the error for the infra build and for each function that imports the module, so the same message can appear several times.

The check follows the imports that load a module at runtime:

- `import { x } from`, when the module uses `x` as a value, including as a JSX tag such as `<X />`. TypeScript removes an import that is used only in types, so `import { type Order }` and `import type` don't count.
- `import "./setup"`, which loads the module for its side effects.
- `export { x } from` and `export * from`.

The check doesn't follow dynamic `import()`, and it doesn't enter packages.

### Files with no kind

A file that no glob matches, such as `lib/format.ts`, has no kind. Both builds bundle it as written. The checks of infra and shared modules don't apply to it. A declaration in such a file is still found and stripped when infra imports it.

**A file with no kind that calls a resource function at its top level stays in the function's bundle.** For example, `lib/queues.ts` with `export const dlq = queue({ id: "dlq", schema: DeadLetter })` fails the runtime build if a function imports anything from it. The error says to add the file to `files.infra`, which leaves it out:

```text
The function in runtime/orders.ts uses queue from @notation/aws/sqs.js, a function that declares infrastructure: queue at lib/queues.ts:3:20. It imports @notation/aws/sqs.js through runtime/orders.ts → runtime/format.ts → lib/queues.ts → @notation/aws/sqs.js. Infra functions can't run in a runtime module. lib/queues.ts calls queue at its top level, but files.infra doesn't match it. Add lib/queues.ts to files.infra to leave it out of the function.
```

So a project that keeps its infra outside `infra/`, such as in `src/`, sets `files.infra` to that folder.

Two cases need a different fix:

- **The file holds a declaration**, such as `lib/fn.ts` with `const dlq = queue(...)` and a `$lambda`. A declaration can't be in an infra module, so the error says to move the call to `queue` to an infra module.
- **A kept option uses a plain value from the file**, such as `event: () => apiGateway.schema(Order)`, where `lib/defs.ts` exports `Order` and calls `queue()`. The option still refers to the file if `files.infra` matches it. The error says to move the value to a shared module, or to a file with no kind.

### Packages

A package file has no kind. Package files are:

- files in `node_modules/`,
- files outside the project root, such as a workspace package that resolves to its own folder,
- files under a folder below the root with a `package.json` that has a `name`, such as `packages/api/` in a monorepo, unless a glob matches them.

A package file is infra only if `files.infra` matches it. `files.infra` can match only files below the root, so a file of a workspace package outside the root is never infra. If the function imports a package file that calls a resource function at its top level, the bundle keeps the file and the build fails, unless the nearest `package.json` sets `"sideEffects": false` and the function uses no value from the file. For a file outside `node_modules/`, the error says to set `"sideEffects": false` if the function uses no value from the file. If it does, the error says to read infra values through the declaration's `env()`, and to move a plain value that the function needs to a file that doesn't call a resource function. A kept option of a declaration that refers to a value from such a file fails the build at the option's line. For a file in `node_modules/`, the error gives no advice. A declaration in a package file outside `node_modules` is found and stripped when infra imports it.
