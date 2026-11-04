# notation types

```sh
notation types [--config <path>]
```

| Option            | Meaning                                                     |
| ----------------- | ----------------------------------------------------------- |
| `--config <path>` | The config file. Default: the nearest `notation.config.ts`. |

Writes `notation-env.d.ts` at the project root. The file types the imports that cross between infra and runtime code:

- A runtime module imports infra `with { type: "infra" }`. It sees each output value as its value, such as a queue's `url` as a `string`. It can call resource factories and `grant`, but no other infra function or method.
- An infra module imports a runtime module `with { type: "runtime" }`. It sees each handler as a `RuntimeRef`, which it can pass to `route()`, `consume()` or `schedule()` but can't call. It can't use the module's other exports.

```ts [infra/orders.ts]
import { queue } from "@notation/aws/sqs";
import * as checkout from "../runtime/checkout" with { type: "runtime" };

export const orderQueue = queue({ name: "orders" });
orderQueue.consume(checkout.processOrder);
```

## The generated file

The file has one block for each import specifier that has an attribute. Each block reads the types of its module, so adding, removing or renaming an export doesn't need a new run. The file changes only when an attributed import specifier appears, disappears or names another module. `notation types` rewrites the file only when its contents change.

TypeScript gives an import the block whose pattern has the longest prefix, and each pattern is the specifier followed by `*`. So a block for `"../runtime/checkout"` also matches `"../runtime/checkout2"` until `notation types` writes a block for it.

For an attributed import that has no block yet, catch-all blocks for `./*` and `../*` give an error type that says to run `notation types`. A named import from such a module fails with `Module '"../*"' has no exported member`.

If the same relative specifier names two different modules from two directories, no pattern can tell them apart, so `notation types` fails. Import one of them with a different specifier.

## Tools

The file needs TypeScript 7.1 or later. TypeScript 6, Prettier and typescript-eslint can't parse it, so exclude `notation-env.d.ts` from them, for example in `.prettierignore`.

`notation compile` writes the file before it compiles, and `notation watch` writes it again when a source file is created, deleted, moved or changed.
