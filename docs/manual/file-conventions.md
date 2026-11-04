# File Conventions

A Notation project has two kinds of code. Infra code declares cloud resources, such as a queue. Runtime code runs inside a deployed resource, such as a Lambda function. Each import that crosses from one kind to the other carries an import attribute that names the side it comes from.

## Directory layout

```sh
my-app/
├── infra/
│   └── orders.ts       # Infra module, and the entry file
├── runtime/
│   ├── checkout.fn.ts  # Runtime module: calls lambda()
│   └── orders.fn.ts    # Runtime module: calls lambda()
├── dist/               # Compiled output (generated)
├── .notation/          # State (generated)
├── notation-env.d.ts   # Types of attributed imports (generated)
├── notation.config.ts  # Project config: app, entry, default stage
├── package.json
└── tsconfig.json
```

## Infra modules

An infra module declares cloud resources. The entry file is the infra module that `notation.config.ts` names in `entry`:

```ts [notation.config.ts]
export default defineConfig({
  app: "my-app",
  entry: "infra/orders.ts",
});
```

```ts [infra/orders.ts]
import { queue } from "@notation/aws/sqs";
import { processOrders } from "runtime/orders.fn" with { type: "runtime" };

export const orderQueue = queue({ name: "orders" });
orderQueue.consume(processOrders, { batchSize: 5 });
```

The CLI deploys the entry file and the modules that it imports. To deploy part of a project separately, give that part its own config. See [Project Config](./project-config.md).

## Runtime modules

A runtime module holds code that runs in a deployed function. It calls [`lambda()`](./function-config.md) to declare the function, and exports the handlers that the function runs:

```ts [runtime/orders.fn.ts]
import { lambda } from "@notation/aws/lambda" with { type: "infra" };

const { handle } = lambda({ id: "orders", timeout: 5, memory: 64 });

export const processOrders = handle.sqsEvent((event) => {
  for (const record of event.Records) console.log("order", record.body);
});

export const processRefunds = handle.sqsEvent((event) => {
  for (const record of event.Records) console.log("refund", record.body);
});
```

**A file is a runtime module when infra imports it `with { type: "runtime" }`.** The compiler bundles each function that a runtime module declares. A runtime module that no infra module imports isn't built, and its functions aren't deployed. The compiler warns about such a file when it matches [`runtimeModules`](#runtimemodules); see below.

Runtime modules can import ordinary modules, such as `runtime/utils.ts`, without an attribute. Notation bundles the shared code into each function that uses it.

## Import attributes

Two attributes mark the imports that cross between infra and runtime code:

| Attribute                  | Where                 | Target                                                         | The importer sees                                                     |
| -------------------------- | --------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------- |
| `with { type: "runtime" }` | In an infra module    | A runtime module of this project                               | Each handler as a `RuntimeRef`, which infra can wire but not call    |
| `with { type: "infra" }`   | In a runtime module   | An infra module, or a provider's factory, such as `@notation/aws/lambda` | Each output value as its value, such as a queue's `url` as a `string` |

[`notation types`](../cli/types.md) writes `notation-env.d.ts`, which gives each side its view of the other. See [End-to-End Types](./types.md) and [Reading Infra Values](./infra-values.md).

The build fails when an import breaks these rules:

- `type: "infra"` in an infra module, or `type: "runtime"` in runtime code.
- `type: "runtime"` on an import of a package.
- Runtime code that imports an infra package, such as `@notation/aws/sqs`, without `type: "infra"`. The function's bundle would include infra.
- Infra that imports a file matching `runtimeModules` without `type: "runtime"`. See below.

Tests import runtime modules without an attribute, so each handler is a plain function. See [Testing Handlers](./testing.md).

### `runtimeModules`

`runtimeModules` in `notation.config.ts` is a glob, or an array of globs, relative to the config. The default is `**/*.fn.ts`. Infra must import a file that matches a glob `with { type: "runtime" }`, so a forgotten attribute fails the build:

```
runtime/orders.fn.ts is a runtime module, so infra must import it with { type: "runtime" }.
```

The globs don't decide which files are runtime modules. A file that doesn't match, such as `runtime/checkout.ts`, is still a runtime module when infra imports it with the attribute. Files in `node_modules/` and `dist/` never match.

The compiler also uses the globs to find runtime modules that nothing deploys. It warns about a file when all of these are true:

- The file matches a glob.
- The file imports a package `with { type: "infra" }`, as a module that calls `lambda()` imports `@notation/aws/lambda`.
- No infra module imports the file `with { type: "runtime" }`.
- No module that a runtime module imports, directly or through other modules, imports the file. So a helper module that calls `lambda()` for a runtime module gets no warning.

The warning names the file and shows the import to add:

```
runtime/refunds.fn.ts matches runtimeModules and imports @notation/aws/lambda with { type: "infra" }, but no infra module imports it with { type: "runtime" }, so its functions aren't deployed. To deploy them, import it from infra, as in `import * as handlers from "../runtime/refunds.fn" with { type: "runtime" };` in infra/main.ts, and pass its handlers to infra APIs such as route() or consume().
```

It is a warning, not an error, so that a runtime module in progress doesn't block a deploy. A project that deploys its parts with separate configs can narrow each config's `runtimeModules` to its own part, so that one config doesn't warn about the runtime modules of another.

```ts [notation.config.ts]
export default defineConfig({
  app: "my-app",
  entry: "infra/orders.ts",
  runtimeModules: "runtime/**",
});
```

## Infra imports a runtime module

Infra code imports the handlers of a runtime module and passes them to infra APIs, such as `queue.consume`:

```ts [infra/orders.ts]
import {
  processOrders,
  processRefunds,
} from "runtime/orders.fn" with { type: "runtime" };

orderQueue.consume(processOrders, { batchSize: 5 });
refundQueue.consume(processRefunds);
```

**The compiler runs infra modules before runtime modules.** While infra modules run, each import of a runtime module gives a stand-in for each export, and none of the runtime module's code runs. Infra APIs such as `consume` record the stand-in and wire it once all infra has run. Then the compiler runs the `lambda()` calls of each runtime module, and links each stand-in to its handler. So the plan doesn't depend on the order in which infra modules load. See [Compiler](../internals/compiler.md).

Infra can only use the handlers of a runtime module, and an exported `lambda()` result. Every other export, such as a helper or a constant, has a type that infra can't use. Put code that infra and runtime share in an ordinary module.

## Limits

- **TypeScript 7.1 or later** is needed to type the attributed imports. TypeScript 6, Prettier and typescript-eslint can't parse `notation-env.d.ts`, so exclude the file from them. See [notation types](../cli/types.md#tools).
- **Renaming a handler in your editor doesn't reach infra.** See [End-to-End Types](./types.md#renaming-a-handler).
- **`lambda()` settings lose effects that they don't reference.** See [Function Settings](./function-config.md#settings-are-ordinary-code).
- **Plain Node can't load runtime modules.** Node overflows its stack on a cycle of TypeScript imports that carry attributes, so tests and scripts need Notation's loader hook. See [Testing Handlers](./testing.md).
