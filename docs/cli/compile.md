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

```ts [infra build]
import { $lambda, http } from "@notation/aws/lambda";

export const lambda = __notation_declaredIn(
  $lambda({
    id: "todos",
    timeout: 5,
    memory: 64,
    event: () => http(),
  }),
  "runtime/todos.ts",
  "lambda",
);

function __notation_declaredIn(value, path, binding) {
  /* ... */
}
```

::

`__notation_declaredIn` records the module's path, relative to the project root, against the declaration. When infra runs, `$lambda` reads the record to find the function's bundle.

2. **Runtime compilation** – the compiler bundles each runtime module that the first pass found to `dist/<module path>/index.mjs`, such as `dist/runtime/todos/index.mjs`. The bundle exports the module's `handler`, so Lambda calls `index.handler`. The declaration keeps only `id`, `event`, and the names in `env`. Infra modules are left out, and the build fails if the function uses an infra module or calls a resource function such as `queue()`.

**The first pass also compiles runtime modules that the entry doesn't import.** It scans the files that `files.runtime` in `notation.config.ts` matches, and the infra bundle imports each runtime module that it finds after the entry. See [Runtime modules that infra doesn't import](../manual/file-conventions.md#runtime-modules-that-infra-doesnt-import).

The build fails with the file and line when:

- a runtime module doesn't export `handler`,
- a runtime module has more than one declaration,
- an infra module imports a name from a runtime module that the declaration doesn't use,
- `$lambda` is not called as `const name = $lambda({ ... })` at the top level, with an object literal,
- `event` refers to an infra module,
- a shared module breaks its rules. See [Shared modules](../manual/file-conventions.md#shared-modules), or
- the function uses an infra module, or a resource function from a package. The error names each use and the chain of imports. The check reads the code before minify, so an unused call to an infra helper or to `queue()` also fails the build. If a file that `files.infra` doesn't match calls the resource function at its top level, the error says to add the file to `files.infra`. If that file holds a declaration, the error says to move the call to an infra module instead. If the file is in a workspace package or a package folder, the error says that if the function doesn't use a value from the file, the package's `package.json` can set `"sideEffects": false`, so that the bundler can leave the file out. If the function does use a value from it, the error says to read infra values through the declaration's `env()`, and to move a plain value that the function needs to a file that doesn't call a resource function.

See [Compiler](../internals/compiler.md) for how each pass works.
