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

`name` keys the API in state. In AWS, the API is named `<app>--<stage>--<name>`, such as `my-app--prod--my-api`. See [AWS names](../manual/project-config.md#aws-names).

## `router(api)`

```ts [infra/api.ts]
import { api, router } from "@notation/aws/api-gateway";
import { lambda as users } from "runtime/users";

const myApi = api({ name: "user-api" });
const myRouter = router(myApi);

myRouter.get("/users", () => users);
myRouter.post("/users", () => users);
```

`users` is the declaration from the runtime module `runtime/users.ts`. The router methods take it as a function, `() => users`, and call the function when infra has finished loading. The declaration must have `event: () => http()`, or no `event`. See [Wiring a declaration](lambda.md#wiring-a-declaration). The methods also take a Lambda group from [`lambda()`](lambda.md#lambdaconfig), as it is.

Both routes call the one `users` function. Its handler reads `event.routeKey`, such as `GET /users` or `POST /users`, to tell them apart.

### Available methods

- `.get(path, target)`
- `.post(path, target)`
- `.put(path, target)`
- `.patch(path, target)`
- `.delete(path, target)`

The methods return nothing.

### What each route generates

Each route call produces a full resource subgraph:

- **API Gateway route** – the HTTP method + path binding
- **Lambda integration** – connects the API to the Lambda function. Routes on one API that call one function share it
- **Lambda invoke permission** – allows API Gateway to call the function. Routes on one API that call one function share it

### Request bodies

`http(schema)` gives the declaration a [Standard Schema](https://standardschema.dev) for request bodies. The handler validates a request with `lambda.decode(event)`, which decodes a base64 body, parses it as JSON and returns the schema's output type. See [Validating bodies with `decode()`](../manual/functions.md#validating-bodies-with-decode).

## JWT Authorization

```ts [infra/api.ts]
import { api, router } from "@notation/aws/api-gateway";
import { lambda as user } from "runtime/user";

const myApi = api({ name: "user-api" });

const authedRouter = router(myApi).withJWTAuthorizer({
  type: "jwt",
  issuer: "https://myaccount.auth0.com/",
  audience: ["https://my-api"],
  scopes: [],
});

authedRouter.get("/user", () => user);
```

The authorizer adds the token's claims to the request. `withJWTAuthorizer()` doesn't carry a claims type, so the handler types the event itself, with `APIGatewayJWTProxyEventV2` from `@notation/aws/shared`:

```ts [runtime/user.ts]
import { $lambda, http } from "@notation/aws/lambda";
import type { APIGatewayJWTProxyEventV2 } from "@notation/aws/shared";
import type { JWTClaims } from "shared/jwt";

export const lambda = $lambda({
  id: "user",
  event: () => http(),
});

export const handler = async (event: APIGatewayJWTProxyEventV2<JWTClaims>) => {
  return { message: event.requestContext.authorizer.jwt.claims.$username };
};
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
import { lambda as todos } from "runtime/todos";

const todoApi = api({ name: "todo-api" });
const todoRouter = router(todoApi);

todoRouter.get("/todos", () => todos);
todoRouter.get("/todos/count", () => todos);
```

```ts [runtime/todos.ts]
import { $lambda, http, type LambdaHandler } from "@notation/aws/lambda";
import { api } from "./utils";

export const lambda = $lambda({
  id: "todos",
  timeout: 5,
  memory: 64,
  event: () => http(),
});

const todos = await api.get<any[]>("/todos");

export const handler: LambdaHandler<typeof lambda> = async (event) => {
  if (event.routeKey === "GET /todos/count") return todos.length;
  return todos;
};
```

::

From these two files, Notation declares an API Gateway HTTP API and a deployment stage, one Lambda function with its IAM role, zip package and CloudWatch log group, one Lambda integration, one invoke permission, and two API Gateway routes. Both routes call the `todos` function, and its handler branches on `event.routeKey`.
