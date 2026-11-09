# API Gateway

`@notation/aws/api-gateway` builds HTTP APIs backed by Lambda functions. A Lambda function receives the requests of a route in one of two ways:

| Function-led                                                                | Infra-led                                                              |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `event: () => apiGateway.bind(todoApi).defineRoute({ method, path })`       | `event: () => apiGateway.schema(NewTodo)`                              |
| The declaration makes one route on an API that infra declares.              | Infra makes routes with `router(todoApi).post("/todos", () => todos)`. |
| `decode()` validates with the route's `schema` and the authorizer's claims. | `decode()` validates with `NewTodo` and the declaration's claims.      |

`apiGateway` comes from `@notation/aws/lambda`. `api()`, `jwtAuthorizer()` and `router()` come from `@notation/aws/api-gateway`, and only run in infra.

## `api(config)`

```ts [infra/api.ts]
import { api } from "@notation/aws/api-gateway";

export const todoApi = api({ name: "todo-api" });
```

### Config

```ts [@notation/aws/api-gateway]
type ApiConfig = {
  name: string;
};
```

`name` keys the API in state. In AWS, the API is named `<app>--<stage>--<name>`, such as `my-app--prod--todo-api`. See [AWS names](../manual/project-config.md#aws-names).

`api()` also makes the `$default` stage, which deploys each change.

## `apiGateway.bind(api).defineRoute(options)`

A declaration names the API and the route that its function serves in `event`:

::code-group

```ts [runtime/create-todo.ts]
import { $lambda, apiGateway, type LambdaHandler } from "@notation/aws/lambda";
import { todoApi } from "infra/api";
import { NewTodo } from "shared/schema";

export const lambda = $lambda({
  id: "create-todo",
  event: () =>
    apiGateway
      .bind(todoApi)
      .defineRoute({ method: "POST", path: "/todos", schema: NewTodo }),
});

export const handler: LambdaHandler<typeof lambda> = async (event) => {
  const todo = await lambda.decode(event);
  return { statusCode: 201, body: JSON.stringify(todo) };
};
```

```ts [infra/api.ts]
import { api } from "@notation/aws/api-gateway";

export const todoApi = api({ name: "todo-api" });
```

::

The infra module only declares the API. When infra has finished loading, the declaration makes the route `POST /todos` on `todoApi` to the `create-todo` function. See [What each route generates](#what-each-route-generates).

### Options

```ts [@notation/aws/lambda]
type ApiGatewayRouteOptions = {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: `/${string}`;
  schema?: StandardSchemaV1;
  auth?: JwtAuthorizerGroup; // from jwtAuthorizer()
};
```

`schema` validates the JSON body of a request in `lambda.decode(event)`. `auth` puts the route behind a JWT authorizer; see [JWT authorization](#jwt-authorization).

### In the runtime build

**The function doesn't load `infra/api.ts`.** The runtime build replaces `todoApi` with `{}`, because `api()` is marked `@resource runtime:` with no options, and the function reads nothing from the API:

```ts [runtime/create-todo.ts, as the runtime build strips it]
export const lambda = $lambda({
  id: "create-todo",
  event: () =>
    apiGateway
      .bind({}) // <- todoApi
      .defineRoute({ method: "POST", path: "/todos", schema: NewTodo }),
});
```

`NewTodo` stays as it is, so it must come from a shared module or a package. An authorizer in `auth` becomes an object of its claims schema; see [JWT authorization](#jwt-authorization).

`defineRoute()` makes one route. To serve several routes from one function, declare it with `apiGateway.schema()` and route it from infra with `router()`.

## `apiGateway.schema(body, options)`

A declaration that infra routes to names the schemas of its requests, and no API:

```ts [runtime/todos.ts]
import { $lambda, apiGateway, type LambdaHandler } from "@notation/aws/lambda";
import { NewTodo } from "shared/schema";

export const lambda = $lambda({
  id: "todos",
  event: () => apiGateway.schema(NewTodo),
});
```

Both arguments are optional. A function that only serves `GET` routes has no body to validate, so it calls `apiGateway.schema()`, or `apiGateway.schema(undefined, { claims: Claims })` for routes behind an authorizer.

```ts [@notation/aws/lambda]
apiGateway.schema(body?: StandardSchemaV1, options?: { claims?: StandardSchemaV1 });
```

`options.claims` decides which routes can invoke the function:

- With `claims`, the event has the kind `apiGateway-jwt`, and only routes with an authorizer can invoke the function.
- Without `claims`, the event has the kind `apiGateway`, and only routes with no authorizer can invoke the function.

## `router(api)`

```ts [infra/api.ts]
import { api, router } from "@notation/aws/api-gateway";
import { lambda as todos } from "runtime/todos";

const todoApi = api({ name: "todo-api" });
const todoRouter = router(todoApi);

todoRouter.get("/todos", () => todos);
todoRouter.post("/todos", () => todos);
```

`todos` is the declaration from the runtime module `runtime/todos.ts`. The router methods take it as a function, `() => todos`, and call the function when infra has finished loading. See [Wiring a declaration](lambda.md#wiring-a-declaration). The methods also take a Lambda group from [`lambda()`](lambda.md#lambdaconfig), as it is.

Both routes call the one `todos` function. Its handler reads `event.routeKey`, such as `GET /todos` or `POST /todos`, to tell them apart.

### Available methods

- `.get(path, target)`
- `.post(path, target)`
- `.put(path, target)`
- `.patch(path, target)`
- `.delete(path, target)`
- `.withAuthorizer(authorizer)`, which returns the same five methods for routes behind the authorizer

The route methods return nothing.

### Targets

| Target                                                     | Route with no authorizer | Route with an authorizer                                         |
| ---------------------------------------------------------- | ------------------------ | ---------------------------------------------------------------- |
| A declaration with `apiGateway.schema(body)`               | Routed                   | Throws                                                           |
| A declaration with `apiGateway.schema(body, { claims })`   | Throws                   | Routed if the authorizer's `claims` is the same schema, or unset |
| A declaration with no `event`                              | Routed                   | Routed                                                           |
| A Lambda group from `lambda()`                             | Routed                   | Routed                                                           |
| A declaration with `apiGateway.bind(api).defineRoute(...)` | Throws                   | Throws                                                           |

A declaration with `defineRoute()` already makes its route, so `router()` throws for it. Route the function in one place: remove the router call, or declare the function with `apiGateway.schema()`.

TypeScript checks the same pairings, except for the last row.

### What each route generates

Each route, from `router()` or from `defineRoute()`, produces a full resource subgraph:

- **API Gateway route** – the HTTP method + path binding
- **Lambda integration** – connects the API to the Lambda function. Routes on one API that call one function share it
- **Lambda invoke permission** – allows API Gateway to call the function. Routes on one API that call one function share it

### Request bodies

`lambda.decode(event)` decodes a base64 body, parses it as JSON, validates it with the body schema and returns the schema's output type. With no body schema, it returns the parsed JSON as `unknown`, or `undefined` for a request with no body. See [Validating bodies with `decode()`](../manual/functions.md#validating-bodies-with-decode).

## JWT authorization

A JWT authorizer is a resource on an API. It holds the token's issuer and audience, and a schema for the token's claims:

```ts [infra/api.ts]
import { api, jwtAuthorizer } from "@notation/aws/api-gateway";
import { Claims } from "shared/claims";

export const userApi = api({ name: "user-api" });

export const userAuth = jwtAuthorizer({
  api: userApi,
  issuer: "https://myaccount.auth0.com/",
  audience: ["https://my-api"],
  claims: Claims,
});
```

A declaration puts its route behind the authorizer with `auth`:

```ts [runtime/user.ts]
import { $lambda, apiGateway, type LambdaHandler } from "@notation/aws/lambda";
import { userApi, userAuth } from "infra/api";

export const lambda = $lambda({
  id: "user",
  event: () =>
    apiGateway
      .bind(userApi)
      .defineRoute({ method: "GET", path: "/user", auth: userAuth }),
});

export const handler: LambdaHandler<typeof lambda> = async (event) => {
  await lambda.decode(event); // <- throws a DecodeError for claims that Claims rejects
  return { message: event.requestContext.authorizer.jwt.claims.sub };
};
```

In the runtime build, `userAuth` becomes `{ claims: Claims }`, with `Claims` imported from where `infra/api.ts` imports it. `jwtAuthorizer()` is marked `@resource runtime: claims`, so the claims schema must come from a shared module, as a queue's schema does for `sqs.bind()`.

Infra routes to a declaration with `withAuthorizer()`:

::code-group

```ts [infra/api.ts]
router(userApi)
  .withAuthorizer(userAuth)
  .get("/profile", () => profile);
```

```ts [runtime/profile.ts]
export const lambda = $lambda({
  id: "profile",
  event: () => apiGateway.schema(undefined, { claims: Claims }),
});
```

::

**The claims check compares objects, not types.** `withAuthorizer()` routes throw when the authorizer's `claims` is another object than the one in `apiGateway.schema()`. TypeScript also checks the pairing: a declaration whose claims schema has another type than the authorizer's is a type error. An authorizer with no `claims` can route to a declaration with any claims schema, because the function still validates the claims. `withAuthorizer()` also throws for an authorizer on another API.

### Claims in `decode()`

`lambda.decode(event)` validates `event.requestContext.authorizer.jwt.claims` with the claims schema before it reads the body. It throws a `DecodeError` when the claims are not valid, and when the request has no claims. It returns only the body.

The handler's event types the claims as `JwtClaims`, the loose type from `aws-lambda`, because API Gateway passes them as the token holds them. The claims schema's output type is not used in the event.

### JwtAuthorizerConfig

```ts [@notation/aws/api-gateway]
type JwtAuthorizerConfig = {
  api: ApiGroup;
  issuer: string;
  audience: string[];
  scopes?: string[];
  claims?: StandardSchemaV1;
};
```

The authorizer owns its API Gateway authorizer resource. An HTTP API allows 10 authorizers, and two authorizers on one API with the same `issuer` and `audience` fail with a duplicate id. Each route of the authorizer requires its `scopes`.

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
import { $lambda, apiGateway, type LambdaHandler } from "@notation/aws/lambda";
import { api } from "./utils";

export const lambda = $lambda({
  id: "todos",
  timeout: 5,
  memory: 64,
  event: () => apiGateway.schema(),
});

const todos = await api.get<any[]>("/todos");

export const handler: LambdaHandler<typeof lambda> = async (event) => {
  if (event.routeKey === "GET /todos/count") return todos.length;
  return todos;
};
```

::

From these two files, Notation declares an API Gateway HTTP API and a deployment stage, one Lambda function with its IAM role, zip package and CloudWatch log group, one Lambda integration, one invoke permission, and two API Gateway routes. Both routes call the `todos` function, and its handler branches on `event.routeKey`.
