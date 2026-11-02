# notation compile

```sh
notation compile [--config <path>]
```

| Option            | Meaning                                                     |
| ----------------- | ----------------------------------------------------------- |
| `--config <path>` | The config file. Default: the nearest `notation.config.ts`. |

Compiles the entry file and its runtime modules to `dist/`. The output is the same for every stage, so `compile` takes no `--stage`. There are two passes:

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
