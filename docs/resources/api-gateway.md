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

Routes on one API with the same `issuer` and `audience` share one authorizer. Routes with different `scopes` still share it, because API Gateway checks scopes on the route. An HTTP API allows 10 authorizers, so one API can have 10 distinct issuer and audience pairs.

### JWTAuthorizerConfig

```ts [@notation/aws/api-gateway.ts]
type JWTAuthorizerConfig = {
  type: "jwt";
  issuer: string;
  audience: string[];
  scopes: string[];
};
```

## Integrations and authorizers after an unknown create

After a create with an unknown outcome, Notation looks the resource up before it creates it again. An API is found by its `notation:create-token` tag, a route by its route key and a Lambda function by its name and the tag. An integration or authorizer has no tag and no unique key, so Notation cannot look it up. It is created again in two cases:

1. The process stops after AWS creates the integration or authorizer and before Notation records it. The next run creates it again.
2. `CreateIntegration` or `CreateAuthorizer` times out or gets a server error after AWS has created it. The deploy fails, and the next deploy creates it again.

The extra integration or authorizer has no route pointing at it, so traffic is unaffected. Notation does not record it and does not delete it. Deleting the API deletes it.

An extra authorizer counts toward the quota of 10 authorizers per HTTP API, and an extra integration counts toward the quota of 300 integrations per API. Delete an extra one in the console if an API reaches its quota.

An API can also be created twice. Notation looks for the API's tag with `GetApis` one second after an unknown create. If AWS created the API and `GetApis` does not list it yet, Notation creates a second API. Notation records the second API and does not delete the first. A route created twice fails the deploy on its duplicate route key instead.

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
  id: "todos",
  timeout: 5,
  memory: 64,
};
```

::

From these two files, the compiler generates an API Gateway HTTP API, two Lambda functions (each with its own IAM role, zip package, and CloudWatch log group), two API Gateway routes, two Lambda integrations, two invoke permissions, and a deployment stage.
