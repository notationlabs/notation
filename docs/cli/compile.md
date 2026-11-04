# notation compile

```sh
notation compile [--config <path>]
```

| Option            | Meaning                                                     |
| ----------------- | ----------------------------------------------------------- |
| `--config <path>` | The config file. Default: the nearest `notation.config.ts`. |

Compiles the entry file and its runtime modules to `dist/`. The output is the same for every stage, so `compile` takes no `--stage`. There are two passes:

1. **Infrastructure compilation** – esbuild bundles the infra entry point to `dist/infra/<entry>.mjs`. When the entry imports a [runtime module](../manual/file-conventions.md#runtime-modules), the compiler replaces the module with a generated module that declares its resource. The example below is simplified. The real module starts its own names with `__notation`, so they don't clash with the module's exports:

::code-group

```ts [runtime/todos.fn.ts]
export const getTodos = handle.apiRequest(() => { ... });

export const resource: LambdaResource = { service: "aws/lambda", id: "todos" };
```

```ts [generated module]
import { lambda } from "@notation/aws/lambda";

const resource = lambda({
  id: "todos",
  code: { type: "file", path: "dist/runtime/todos.fn/index.mjs" },
});

export const getTodos = { resource, export: "getTodos" };
```

::

2. **Runtime compilation** – the compiler bundles each runtime module that the first pass replaced to `dist/<module path>/index.mjs`. A runtime module that the entry doesn't import isn't bundled. The bundle exports one `handler`, which sends each event to an export of the module. See [Dispatch](../resources/lambda.md#dispatch).

If a file that matches `runtimeModules` exports the old `config` object (one with a `service` property) and no `resource`, the build fails with a message to rename the export.
