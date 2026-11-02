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
├── notation.config.ts
├── package.json
└── tsconfig.json
```

## 2. Explore the code

The starter template gives you a project config and two directories: infrastructure and runtime.

**`notation.config.ts`** – names the app and its entry file:

```ts [notation.config.ts]
import { defineConfig } from "@notation/core/config";

export default defineConfig({
  app: "my-app",
  entry: "infra/api.ts",
  defaultStage: "dev",
});
```

With this config, `npm run deploy` deploys `infra/api.ts` to the `dev` stage. To deploy to another stage, pass `--stage`: `npm run deploy -- --stage prod`. See [Project Config](./project-config.md).

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
import { handle, json, type LambdaResource } from "@notation/aws/lambda.fn";

export const getTodos = handle.apiRequest(() => {
  return json([{ id: 1, text: "Learn Notation" }]);
});

export const getTodoCount = handle.apiRequest(() => {
  return json(1);
});

export const resource: LambdaResource = {
  service: "aws/lambda",
  id: "todos",
  timeout: 5,
  memory: 64,
};
```

::

Infrastructure and runtime live in the same codebase. `runtime/todos.fn.ts` is a runtime module, because it exports `resource`. It deploys as one Lambda function with the ID `todos`, and both handlers run in that function. The router wires each handler to an API Gateway route, and Notation infers the intermediate resources – IAM roles, permissions, integrations, and so on. See [Runtime modules](./file-conventions.md#runtime-modules).

## 3. Visualize the graph

```sh
npm run viz
```

```sh
✔ Compiled infra/api.ts → 11 resources
→ https://notation.dev/viz/abc123
```

Opens a Mermaid chart of the resource graph. This is what Notation will deploy.

## 4. Deploy

```sh
npm run deploy
```

```sh
✔ Compiled infra/api.ts → 11 resources
✔ Diffed against state → 11 to create, 0 to update, 0 to destroy
✔ Deploying...

  ✔ iam-role/todos-role             created
  ✔ lambda/todos                    created
  ✔ api-gateway/todo-api            created
  ✔ integration/todo-api-todos      created
  ✔ route/GET /todos                created
  ✔ route/GET /todos/count          created
  ...

✔ Deployed 11 resources

  GET https://abc123.execute-api.us-east-1.amazonaws.com/todos
  GET https://abc123.execute-api.us-east-1.amazonaws.com/todos/count
```

Notation compiles your infrastructure, diffs it against the state of the `dev` stage, and deploys resources in dependency order. On first deploy, everything is created.

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
✔ lambda/todos                    updated

  Ready.
```

Notation recompiles the graph and redeploys only the resources that changed.

## 6. Tear down

```sh
npm run destroy
```

```sh
✔ Compiled infra/api.ts → 11 resources
✔ Destroying in reverse dependency order...

  ✔ route/GET /todos/count          destroyed
  ✔ route/GET /todos                destroyed
  ✔ integration/todo-api-todos      destroyed
  ✔ api-gateway/todo-api            destroyed
  ✔ lambda/todos                    destroyed
  ✔ iam-role/todos-role             destroyed
  ...

✔ Destroyed 11 resources
```

Everything is removed in reverse dependency order.
