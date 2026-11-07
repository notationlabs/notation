# notation compile

```sh
notation compile [--config <path>]
```

| Option            | Meaning                                                     |
| ----------------- | ----------------------------------------------------------- |
| `--config <path>` | The config file. Default: the nearest `notation.config.ts`. |

Compiles the entry file and its runtime modules to `dist/`. The output is the same for every stage, so `compile` takes no `--stage`. The compiler uses Rolldown, and runs two passes:

1. **Infrastructure compilation** – the compiler bundles the infra entry point to `dist/infra/<entry>.mjs`, with a source map. Packages stay external, and imports through tsconfig `paths` are bundled. Each [runtime module](../manual/file-conventions.md#runtime-modules) that the entry imports is replaced by a stripped copy, which keeps only the declaration and the top-level statements that it uses:

::code-group

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

```ts [infra build]
import { createLambda, http } from "@notation/aws/lambda";

export const lambda = $declaredIn(createLambda({
  id: "todos",
  timeout: 5,
  memory: 64,
  event: () => http(),
}), "file:///path/to/my-app/runtime/todos.fn.ts", "lambda");

function $declaredIn(value, url, binding) { /* ... */ }
```

::

`$declaredIn` records the module's file URL against the declaration. When infra runs, `createLambda` reads the record to find the function's bundle.

2. **Runtime compilation** – the compiler bundles each runtime module that the first pass found to `dist/<module path>/index.mjs`, such as `dist/runtime/todos.fn/index.mjs`. The bundle exports the module's `handler`, so Lambda calls `index.handler`. The declaration keeps only `event`, and the names in `env`. Infra modules are left out.

**A runtime module that the entry doesn't import isn't compiled or deployed.** `runtimeModules` in `notation.config.ts` is not read by the build yet. See [Runtime modules must be imported](../manual/file-conventions.md#runtime-modules-must-be-imported).

The build fails with the file and line when:

- a runtime module doesn't export `handler`,
- a runtime module has more than one declaration,
- `createLambda` is not called as `const name = createLambda({ ... })` at the top level, with an object literal,
- `event` refers to an infra module, or
- the function's bundle still contains an infra module. The error names the chain of imports.

See [Compiler](../internals/compiler.md) for how each pass works.
