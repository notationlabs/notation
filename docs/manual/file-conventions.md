# File Conventions

Notation uses file naming conventions to determine how modules are compiled and deployed.

## Directory layout

```sh
my-app/
├── infra/           # Infrastructure definitions
│   └── api.ts       # Stack entry point
├── runtime/         # Lambda handler code
│   ├── todos.fn.ts  # Handler module
│   └── utils.ts     # Shared runtime utilities
├── dist/            # Compiled output (generated)
├── .notation/       # State (generated)
├── package.json
└── tsconfig.json
```

## Infrastructure modules

Location: `infra/*.ts`

The entry point passed to CLI commands. Defines your cloud resources.

```ts [infra/api.ts]
import { api, router } from "@notation/aws/api-gateway";
import { getTodos } from "runtime/todos.fn";

const todoApi = api({ name: "todo-api" });
const todoRouter = router(todoApi);
todoRouter.get("/todos", getTodos);
```

Infrastructure modules are the top-level units of deployment. Each file in `infra/` represents a stack that can be compiled and deployed independently.

## Runtime modules

Location: `runtime/*.fn.ts`

The `.fn.ts` suffix tells Notation this module exports Lambda handlers. During compilation, the [function-infra-plugin](../internals/compiler.md) intercepts these files and transforms each exported handler into a Lambda resource declaration.

A `.fn.ts` file can export:

- One or more handler functions (via `handle.*`)
- An optional `config` export for Lambda settings (`LambdaConfig`)

```ts [runtime/todos.fn.ts]
import type { LambdaConfig } from "@notation/aws/lambda.fn";
import { handle, json } from "@notation/aws/lambda.fn";

export const getTodos = handle.apiRequest(() => {
  return json([{ id: 1, text: "Learn Notation" }]);
});

export const config: LambdaConfig = {
  service: "aws/lambda",
  timeout: 5,
  memory: 64,
};
```

Other files in `runtime/` without the `.fn.ts` suffix (e.g. `utils.ts`) are treated as regular modules – they're bundled as shared code but don't produce Lambda resources.
