# Quickstart

Scaffold, preview, deploy, inspect, and tear down an AWS HTTP API and Lambda function from one TypeScript project.

## Prerequisites

Configure these tools and AWS environment settings before running CLI commands:

| Prerequisite | Requirement |
| :--- | :--- |
| Node.js | Version `>=22.13` for `@notation/cli` |
| AWS credentials | `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`, or `AWS_PROFILE` |
| AWS region | `AWS_REGION` exported in your shell |

Export your target AWS region before running CLI commands:

```sh [Terminal]
export AWS_REGION=us-east-1
```

## Scaffold the project

`create-notation` initializes a TypeScript project preconfigured with `notation.config.ts`, `@notation/cli`, `@notation/aws`, and `@notation/core`.

Create a starter project in `./notation-starter`:

```sh [Terminal]
@pm.dlx("create-notation")
```

Move into the generated directory:

```sh [Terminal]
cd notation-starter
```

## Project files

The starter separates project config, infrastructure, and runtime handlers across `notation.config.ts`, `infra/api.ts`, and `runtime/todos.ts`.

Inspect the generated files side by side:

::code-group

```ts [notation.config.ts]
import { defineConfig } from "@notation/core/config";

export default defineConfig({
  app: "notation-starter",
  entry: "infra/api.ts",
  defaultStage: "dev",
});
```

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
  event: () => apiGateway.schema(null),
});

const todos = await api.get<any[]>("/todos");

export const handler: LambdaHandler<typeof lambda> = async () => {
  return todos;
};
```

```ts [runtime/utils.ts]
export const api = {
  get: async <T = any>(path: string) => {
    const res = await fetch(`https://jsonplaceholder.typicode.com${path}`);
    return res.json() as Promise<T>;
  },
};
```

```json [package.json]
{
  "private": true,
  "name": "notation-starter",
  "scripts": {
    "compile": "notation compile",
    "dashboard": "notation dashboard",
    "deploy": "notation deploy",
    "destroy": "notation destroy",
    "viz": "notation viz",
    "watch": "notation watch"
  },
  "devDependencies": {
    "@types/node": "^22.13.4"
  }
}
```

::

During the infrastructure build, Notation strips handler logic from `runtime/todos.ts` so `api.get("/todos")` runs only inside AWS Lambda.

## Preview changes

`notation plan` compiles both builds, checks local state for `notation-starter:dev`, and previews what will be created without touching AWS.

Run the local binary to inspect the deployment plan:

```sh [Terminal]
./node_modules/.bin/notation plan
```

The output prints `Planning notation-starter:dev` followed by one `+ create` line per resource and a summary.

## Deploy to AWS

Deploying prints a recovery execution ID and provisions each resource in dependency order.

Deploy the `dev` stage:

```sh [Terminal]
@pm.run("deploy")
```

Notation prints `→ create` decisions and live lifecycle events (`…` and `✓`), then saves resource outputs locally.

## Inspect the endpoint

Open the local dashboard to view deployed resources and copy your API Gateway URL.

Start the dashboard server:

```sh [Terminal]
@pm.run("dashboard")
```

Open `http://localhost:6682`, select `api:todo-api`, and copy its `ApiEndpoint` URL (`https://<api-id>.execute-api.<region>.amazonaws.com`). Press `Ctrl+C` when finished.

Send a request to verify the live endpoint:

```sh [Terminal]
curl https://<api-id>.execute-api.<region>.amazonaws.com/todos
```

The Lambda function returns JSON from `jsonplaceholder.typicode.com` with status `200`.

## Iterate with watch mode

Watch mode monitors project files and redeploys changes automatically.

Start the watcher:

```sh [Terminal]
@pm.run("watch")
```

Update `handler` in `runtime/todos.ts` to return only the first five items:

```ts [runtime/todos.ts]
export const handler: LambdaHandler<typeof lambda> = async () => {
  return todos.slice(0, 5);
};
```

Save the file, wait for the redeploy to complete, and re-run `curl` against `/todos` to see five items. Press `Ctrl+C` to stop watching; editing `notation.config.ts` exits `watch` with code `1` so you can restart cleanly.

## Tear down

Destroying deletes every AWS resource for `notation-starter:dev` and clears its local state.

Remove the `dev` deployment:

```sh [Terminal]
@pm.run("destroy")
```

## Local state

Notation writes build artifacts and state relative to `notation.config.ts`:

- **`dist/`** – Compiled infrastructure and per-function runtime bundles.
- **`.notation/workflows.db`** – Local workflow and resource state (override with `NOTATION_DATABASE_PATH`).

Add both `dist/` and `.notation/` to `.gitignore` before committing.
