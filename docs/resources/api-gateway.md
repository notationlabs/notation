# API Gateway

`@notation/aws/api-gateway` builds HTTP APIs backed by Lambda functions.

## `api(config)`

```ts [infra/api.ts]
import { api } from "@notation/aws/api-gateway";

const myApi = api({ name: "my-api" });
```

### Config

```ts [@notation/aws/api-gateway]
type ApiConfig = {
  name: string;
};
```

## `router(api)`

```ts [infra/api.ts]
import { api, router } from "@notation/aws/api-gateway";
import { getUsers, createUser } from "runtime/users.fn";

const myApi = api({ name: "user-api" });
const myRouter = router(myApi);

myRouter.get("/users", getUsers);
myRouter.post("/users", createUser);
```

### Available methods

- `.get(path, handler)`
- `.post(path, handler)`
- `.put(path, handler)`
- `.patch(path, handler)`
- `.delete(path, handler)`

### What each route generates

Each route call produces a full resource subgraph:

- **API Gateway route** – the HTTP method + path binding
- **Lambda integration** – connects the route to the Lambda function
- **Lambda invoke permission** – allows API Gateway to call the function
- **Lambda function + IAM role + log group** – generated from the `.fn.ts` import via the [function-infra-plugin](../internals/compiler.md)

## JWT Authorization

```ts [infra/api.ts]
import { api, router } from "@notation/aws/api-gateway";
import { getUser } from "runtime/user.fn";
import type { JWTClaims } from "shared/jwt";

const myApi = api({ name: "user-api" });

const authedRouter = router(myApi).withJWTAuthorizer<JWTClaims>({
  type: "jwt",
  issuer: "https://myaccount.auth0.com/",
  audience: ["https://my-api"],
  scopes: [],
});

authedRouter.get("/user", getUser);
```

### JWTAuthorizerConfig

```ts [@notation/aws/api-gateway.ts]
type JWTAuthorizerConfig = {
  type: "jwt";
  issuer: string;
  audience: string[];
  scopes: string[];
};
```

## Full example

Infrastructure and runtime side-by-side:

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
  return json([{ id: 1, text: "Build with Notation" }]);
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

From these two files, the compiler generates an API Gateway HTTP API, two Lambda functions (each with its own IAM role, zip package, and CloudWatch log group), two API Gateway routes, two Lambda integrations, two invoke permissions, and a deployment stage.
