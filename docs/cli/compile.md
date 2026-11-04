# notation compile

```sh
notation compile [--config <path>]
```

| Option            | Meaning                                                     |
| ----------------- | ----------------------------------------------------------- |
| `--config <path>` | The config file. Default: the nearest `notation.config.ts`. |

Compiles the entry file and the functions that its runtime modules declare to `dist/`. The output is the same for every stage, so `compile` takes no `--stage`. The command runs these steps:

1. **Writes [`notation-env.d.ts`](./types.md)**, which types the imports between infra and runtime code.
2. **Bundles the infra phase** to `dist/infra/<entry>.mjs`. For the entry `infra/orders.ts`, this is `dist/infra/orders.mjs`. The bundle runs each [runtime module](../manual/file-conventions.md#runtime-modules) after all of infra, as a copy that keeps only its `lambda()` calls and handlers.
3. **Evaluates the infra bundle**, which runs each `lambda()` call and finds the handlers of each function.
4. **Bundles each function** to `dist/functions/<id>/index.mjs`, such as `dist/functions/checkout/index.mjs` for `lambda({ id: "checkout" })`. The bundle exports one `handler`, which sends each event to one of the function's handlers. See [Dispatch](../resources/lambda.md#dispatch).
5. **Lists the values each function reads from infra** in `reads.json` next to its bundle, such as `["infra/orders#orderQueue.url"]`. Plan and deploy deliver these values to the function.

A runtime module that no infra module imports `with { type: "runtime" }` declares no function, so nothing of it is bundled.

See [Compiler](../internals/compiler.md) for how each step works.
