# Quick Start

Build and deploy a todo API to AWS in under 5 minutes.

## 1. Create a project

```sh
npm create notation@alpha my-app
cd my-app
npm install
```

```sh
my-app/
├── infra/
│   └── api.ts
├── runtime/
│   └── todos.fn.ts
├── package.json
└── tsconfig.json
```

## 2. Explore the code

The starter template gives you two directories: infrastructure and runtime.

**`infra/api.ts`** – defines the API Gateway and routes:

::code-group

```ts [infra/api.ts]
import { api, router } from "@notation/aws/api-gateway";
import { getTodos, getTodoCount } from "runtime/todos.fn";

const todoApi = api({ name: "todo-api" });
const todoRouter = router(todoApi);

todoRouter.get("/todos", getTodos);
todoRouter.get("/todos/count", getTodoCount);
```

```ts [runtime/todos.fn.ts]
import type { LambdaConfig } from "@notation/aws/lambda.fn";
import { handle, json } from "@notation/aws/lambda.fn";

export const getTodos = handle.apiRequest(() => {
  return json([{ id: 1, text: "Learn Notation" }]);
});

export const getTodoCount = handle.apiRequest(() => {
  return json(1);
});

export const config: LambdaConfig = {
  service: "aws/lambda",
  timeout: 5,
  memory: 64,
};
```

::

Infrastructure and runtime live in the same codebase. The router wires Lambda handlers to API Gateway routes, and Notation infers the intermediate resources – IAM roles, permissions, integrations, and so on.

## 3. Visualize the graph

```sh
npm run viz
```

```sh
✔ Compiled infra/api.ts → 12 resources
→ https://notation.dev/viz/abc123
```

Opens a Mermaid chart of the resource graph. This is what Notation will deploy.

## 4. Deploy

```sh
npm run deploy
```

```sh
✔ Compiled infra/api.ts → 12 resources
✔ Diffed against state → 12 to create, 0 to update, 0 to destroy
✔ Deploying...

  ✔ iam-role/getTodos-role          created
  ✔ iam-role/getTodoCount-role      created
  ✔ lambda/getTodos                 created
  ✔ lambda/getTodoCount             created
  ✔ api-gateway/todo-api            created
  ✔ route/GET /todos                created
  ✔ route/GET /todos/count          created
  ✔ integration/getTodos            created
  ✔ integration/getTodoCount        created
  ...

✔ Deployed 12 resources

  GET https://abc123.execute-api.us-east-1.amazonaws.com/todos
  GET https://abc123.execute-api.us-east-1.amazonaws.com/todos/count
```

Notation compiles your infrastructure, diffs it against the current state, and deploys resources in dependency order. On first deploy, everything is created.

```sh
curl https://abc123.execute-api.us-east-1.amazonaws.com/todos
```

```json
[{ "id": 1, "text": "Learn Notation" }]
```

## 5. Make a change

Edit the handler in `runtime/todos.fn.ts`:

```ts [runtime/todos.fn.ts]
export const getTodos = handle.apiRequest(() => {
  return json([
    { id: 1, text: "Learn Notation" },
    { id: 2, text: "Ship it" },
  ]);
});
```

Then start watch mode:

```sh
npm run watch
```

```sh
✔ Watching infra/api.ts...
✔ runtime/todos.fn.ts changed
✔ Recompiled → 1 resource changed
✔ lambda/getTodos                 updated

  Ready.
```

Notation recompiles the graph and redeploys only the resources that changed.

## 6. Tear down

```sh
npm run destroy
```

```sh
✔ Compiled infra/api.ts → 12 resources
✔ Destroying in reverse dependency order...

  ✔ integration/getTodoCount        destroyed
  ✔ integration/getTodos            destroyed
  ✔ route/GET /todos/count          destroyed
  ✔ route/GET /todos                destroyed
  ✔ api-gateway/todo-api            destroyed
  ✔ lambda/getTodoCount             destroyed
  ✔ lambda/getTodos                 destroyed
  ✔ iam-role/getTodoCount-role      destroyed
  ✔ iam-role/getTodos-role          destroyed
  ...

✔ Destroyed 12 resources
```

Everything is removed in reverse dependency order.
