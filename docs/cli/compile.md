# notation compile

```sh
notation compile [--config <path>]
```

| Argument          | Meaning                                                        |
| ----------------- | -------------------------------------------------------------- |
| `--config <path>` | The config file. Defaults to the nearest `notation.config.ts`. |

Compiles the entry file and its runtime modules to `dist/` without deploying. Compiling does not depend on a stage, so `compile` takes no `--stage`. Two compilation passes:

1. **Infrastructure compilation** – esbuild bundles the infra entry point with the `function-infra-plugin`. This plugin intercepts `.fn.ts` imports and replaces handler exports with Lambda resource declarations:

```ts [runtime/todos.fn.ts]
export const getTodos = handle.apiRequest(() => { ... });
```

```ts [dist/todos.fn.ts]
import { lambda } from "@notation/aws/lambda";

export const getTodos = lambda({
  handler: "getTodos",
  ...config,
  id: "todos-getTodos",
});
```

2. **Function compilation** – each `.fn.ts` file is bundled separately as a Node.js Lambda handler.

Output goes to `dist/`.
