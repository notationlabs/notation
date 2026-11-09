# Quick Start

Build and deploy a todo API to AWS in under 5 minutes.

Notation requires Node.js 22 or later.

## 1. Create a project

```sh
@pm.dlx("create-notation@alpha my-app")
cd my-app
@pm.install()
```

```sh
my-app/
├── infra/
│   └── api.ts
├── runtime/
│   ├── todos.ts
│   └── utils.ts
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

**`infra/api.ts`** and **`runtime/todos.ts`** – define the API and the function behind it:

::code-group

```ts [infra/api.ts]
import { api, router } from "@notation/aws/api-gateway";
import { lambda as todos } from "runtime/todos";

const todoApi = api({ id: "todo-api" });
const todoRouter = router(todoApi);

todoRouter.get("/todos", () => todos);
```

```ts [runtime/todos.ts]
import { $lambda, apiGateway, type LambdaHandler } from "@notation/aws/lambda";
import { api } from "./utils";

export const lambda = $lambda({
  id: "todos",
  timeout: 5,
  memory: 64,
  event: () => apiGateway.schema(),
});

const todos = await api.get<any[]>("/todos");

export const handler: LambdaHandler<typeof lambda> = async () => {
  return todos;
};
```

::

Infrastructure and runtime live in the same codebase. `runtime/todos.ts` is a runtime module, because it declares a Lambda function with `$lambda`. The function has the ID `todos`, and Lambda calls the module's `handler` export with each request. `api.get` in `runtime/utils.ts` fetches sample todos from `jsonplaceholder.typicode.com`.

`infra/api.ts` imports the declaration, `lambda`, and routes `GET /todos` to it. Notation infers the intermediate resources – IAM roles, permissions, integrations, and so on. See [Runtime modules](./file-conventions.md#runtime-modules).

## 3. Visualize the graph

```sh
@pm.run("viz")
```

```sh
✔ Compiled infra/api.ts → 10 resources
→ https://notation.dev/viz/abc123
```

Opens a Mermaid chart of the resource graph. This is what Notation will deploy.

## 4. Deploy

```sh
@pm.run("deploy")
```

```sh
✔ Compiled infra/api.ts → 10 resources
✔ Diffed against state → 10 to create, 0 to update, 0 to destroy
✔ Deploying...

  ✔ iam-role/todos-role             created
  ✔ lambda/todos                    created
  ✔ api-gateway/todo-api            created
  ✔ integration/todo-api-todos      created
  ✔ route/GET /todos                created
  ...

✔ Deployed 10 resources

  GET https://abc123.execute-api.us-east-1.amazonaws.com/todos
```

Notation compiles your infrastructure, diffs it against the state of the `dev` stage, and deploys resources in dependency order. On first deploy, everything is created.

```sh
curl https://abc123.execute-api.us-east-1.amazonaws.com/todos
```

```json
[{ "userId": 1, "id": 1, "title": "delectus aut autem", "completed": false }, ...]
```

## 5. Make a change

Edit the handler in `runtime/todos.ts`:

```ts [runtime/todos.ts]
export const handler: LambdaHandler<typeof lambda> = async () => {
  return todos.slice(0, 5);
};
```

Then start watch mode:

```sh
@pm.run("watch")
```

```sh
✔ Watching infra/api.ts...
✔ runtime/todos.ts changed
✔ Recompiled → 1 resource changed
✔ lambda/todos                    updated

  Ready.
```

Notation recompiles the graph and redeploys only the resources that changed.

## 6. Tear down

```sh
@pm.run("destroy")
```

```sh
✔ Compiled infra/api.ts → 10 resources
✔ Destroying in reverse dependency order...

  ✔ route/GET /todos                destroyed
  ✔ integration/todo-api-todos      destroyed
  ✔ api-gateway/todo-api            destroyed
  ✔ lambda/todos                    destroyed
  ✔ iam-role/todos-role             destroyed
  ...

✔ Destroyed 10 resources
```

Everything is removed in reverse dependency order.
