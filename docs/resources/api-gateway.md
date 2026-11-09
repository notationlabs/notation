# API Gateway

`@notation/aws/api-gateway` builds HTTP APIs backed by Lambda functions. A Lambda function receives the requests of a route in one of two ways:

| Function-led                                                                  | Infra-led                                                                                 |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `event: () => apiGateway.bind(todoApi).defineRoute({ method, path, schema })` | `event: () => apiGateway.schema(NewTodo)`                                                 |
| The declaration makes one route on an API that infra declares.                | Infra makes routes with `router(todoApi).post("/todos", () => todos)`.                    |
| `decode()` validates with the route's `schema` and the authorizer's claims.   | `decode()` validates with `NewTodo`, and with the claims schema of `.authSchema(Claims)`. |

`apiGateway` comes from `@notation/aws/lambda`. `api()`, `jwtAuthorizer()` and `router()` come from `@notation/aws/api-gateway`, and only run in infra.

## `api(config)`

```ts [infra/api.ts]
import { api } from "@notation/aws/api-gateway";

export const todoApi = api({ id: "todo-api" });
```

### Config

```ts [@notation/aws/api-gateway]
type ApiConfig = {
  id: string;
  name?: string;
};
```

`id` keys the API in state, so changing it replaces the API. Use 1 to 64 letters, digits, hyphens and underscores, as a string literal. In AWS, the API is named `<app>--<stage>--<id>`, such as `my-app--prod--todo-api`.

`name` replaces the `id` in the AWS name, so `api({ id: "todo-api", name: "todos" })` is named `my-app--prod--todos`. See [AWS names](../manual/project-config.md#aws-names).

The routes, integrations and permissions of an API take their state keys from the IDs that they connect. A route is keyed `api-route:<api id>:<METHOD> <path>`, such as `api-route:todo-api:POST /todos`, and an integration `api-integration:<api id>:<lambda id>`. So a change of `name` leaves them as they are.

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
  const { body: todo } = await lambda.decode(event);
  return { statusCode: 201, body: JSON.stringify(todo) };
};
```

```ts [infra/api.ts]
import { api } from "@notation/aws/api-gateway";

export const todoApi = api({ id: "todo-api" });
```

::

The infra module only declares the API. When infra has finished loading, the declaration makes the route `POST /todos` on `todoApi` to the `create-todo` function. See [What each route generates](#what-each-route-generates).

### Options

```ts [@notation/aws/lambda]
type ApiGatewayRouteOptions = {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: `/${string}`;
  schema: StandardSchemaV1 | null;
  auth?: JwtAuthorizerGroup; // from jwtAuthorizer()
};
```

`schema` validates the body of a request in `lambda.decode(event)`. **`schema` is required.** A route whose requests have no body, such as `GET /todos`, passes `schema: null`, and then `decode()` rejects a request with a body. See [Request bodies](#request-bodies). `auth` puts the route behind a JWT authorizer; see [JWT authorization](#jwt-authorization).

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

`defineRoute()` makes one route. To serve several routes from one function, declare it with `apiGateway.schema(body)` and route it from infra with `router()`.

## `apiGateway.schema(body)`

A declaration that infra routes to names the schema of its request bodies, and no API:

```ts [runtime/todos.ts]
import { $lambda, apiGateway, type LambdaHandler } from "@notation/aws/lambda";
import { NewTodo } from "shared/schema";

export const lambda = $lambda({
  id: "todos",
  event: () => apiGateway.schema(NewTodo),
});
```

`body` is required. A function that only serves `GET` routes takes no body, so it calls `apiGateway.schema(null)`.

The event of `apiGateway.schema(body)` has the kind `apiGateway`, so only routes with no authorizer can invoke the function. For routes behind a JWT authorizer, call `.authSchema()` on the event:

| Call                                            | Kind             | Routes that can invoke the function                             |
| ----------------------------------------------- | ---------------- | --------------------------------------------------------------- |
| `apiGateway.schema(NewTodo)`                    | `apiGateway`     | Routes with no authorizer                                       |
| `apiGateway.schema(NewTodo).authSchema(Claims)` | `apiGateway-jwt` | Routes whose authorizer has the claims schema `Claims`, or none |
| `apiGateway.schema(NewTodo).authSchema()`       | `apiGateway-jwt` | Routes with any JWT authorizer                                  |

```ts [@notation/aws/lambda]
apiGateway.schema(body: StandardSchemaV1 | null).authSchema(claims?: StandardSchemaV1);
```

## `router(api)`

```ts [infra/api.ts]
import { api, router } from "@notation/aws/api-gateway";
import { lambda as todos } from "runtime/todos";

const todoApi = api({ id: "todo-api" });
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
| A declaration with `.authSchema(claims)`                   | Throws                   | Routed if the authorizer's `claims` is the same schema, or unset |
| A declaration with `.authSchema()`                         | Throws                   | Routed                                                           |
| A declaration with no `event`                              | Routed                   | Routed                                                           |
| A Lambda group from `lambda()`                             | Routed                   | Routed                                                           |
| A declaration with `apiGateway.bind(api).defineRoute(...)` | Throws                   | Throws                                                           |

A declaration with `defineRoute()` already makes its route, so `router()` throws for it. Route the function in one place: remove the router call, or declare the function with `apiGateway.schema(body)`.

TypeScript checks the same pairings, except for the last row.

### What each route generates

Each route, from `router()` or from `defineRoute()`, produces a full resource subgraph:

- **API Gateway route** – the HTTP method + path binding
- **Lambda integration** – connects the API to the Lambda function. Routes on one API that call one function share it
- **Lambda invoke permission** – allows API Gateway to call the function. Routes on one API that call one function share it

### Request bodies

Request bodies are JSON. `lambda.decode(event)` decodes the body in two steps:

```text
request body → base64 decode, if isBase64Encoded is set → JSON.parse → body schema → body
```

The body schema only sees the parsed value, never the raw string. So the outcome depends on the body schema and on the body that the client sends:

| Body schema  | Request body           | `body` in the result   |
| ------------ | ---------------------- | ---------------------- |
| `NewTodo`    | `{"title":"Buy milk"}` | The parsed JSON        |
| `NewTodo`    | `Buy milk`             | Throws a `DecodeError` |
| `NewTodo`    | Empty, or none         | `undefined`, validated |
| `v.string()` | `"Buy milk"`           | `"Buy milk"`           |
| `v.string()` | `Buy milk`             | Throws a `DecodeError` |
| `null`       | Empty, or none         | `undefined`            |
| `null`       | Any other body         | Throws a `DecodeError` |

**A text body is sent as a JSON string.** A route that takes text declares a string schema, such as `v.string()`, and the client sends the text with its quotes, as `"Buy milk"`. Plain `Buy milk` is not JSON, so `decode()` throws a `DecodeError` with the message "The request body is not valid JSON." A JSON body that the schema rejects throws a `DecodeError` with the schema's issues.

Form bodies and binary bodies are not supported yet.

An empty body is validated as `undefined`, so the schema decides whether a request may have no body. See [Validating bodies with `decode()`](../manual/functions.md#validating-bodies-with-decode).

## JWT authorization

A JWT authorizer is a resource on an API. It holds the token's issuer and audience, and a schema for the token's claims:

```ts [infra/api.ts]
import { api, jwtAuthorizer } from "@notation/aws/api-gateway";
import { Claims } from "shared/claims";

export const userApi = api({ id: "user-api" });

export const userAuth = jwtAuthorizer({
  id: "user-auth",
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
    apiGateway.bind(userApi).defineRoute({
      method: "GET",
      path: "/user",
      schema: null,
      auth: userAuth,
    }),
});

export const handler: LambdaHandler<typeof lambda> = async (event) => {
  const { claims } = await lambda.decode(event); // <- throws a DecodeError for claims that Claims rejects
  return { message: claims.sub };
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
  event: () => apiGateway.schema(null).authSchema(Claims),
});
```

::

**The claims check compares objects, not types.** `withAuthorizer()` routes throw when the authorizer's `claims` is another object than the one in `.authSchema(Claims)`. TypeScript also checks the pairing: a declaration whose claims schema has another type than the authorizer's is a type error.

Either side can leave out the claims schema:

- An authorizer with no `claims` can route to a declaration with any claims schema, because the function still validates the claims.
- A declaration with `.authSchema()` and no claims schema can be routed from any authorizer. The function then doesn't validate the claims.

`withAuthorizer()` also throws for an authorizer on another API.

### Claims in `decode()`

For a request through a JWT authorizer, `lambda.decode(event)` reads `event.requestContext.authorizer.jwt.claims`, validates them with the claims schema, and returns them as a top-level `claims` field, next to `body`:

| Declaration                                      | `claims` in the result of `decode()`              |
| ------------------------------------------------ | ------------------------------------------------- |
| `.authSchema(Claims)`, or `auth` with `Claims`   | The output type of `Claims`                       |
| `.authSchema()`, or `auth` with no claims schema | The claims as API Gateway sends them, `JwtClaims` |
| No authorizer                                    | No `claims` field                                 |

`decode()` throws a `DecodeError` when the claims are not valid, and when the request has no claims. It leaves `requestContext` as API Gateway sent it.

A `DecodeError` has a `part` field, which is `"claims"` for an error in the claims and `"body"` for an error in the body. `decode()` checks the claims before the body. A handler can use `part` to choose the status code:

```ts [runtime/user.ts]
export const handler: LambdaHandler<typeof lambda> = async (event) => {
  try {
    const { claims } = await lambda.decode(event);
    return { message: claims.sub };
  } catch (error) {
    if (!(error instanceof DecodeError)) throw error;
    const statusCode = error.part === "claims" ? 403 : 400;
    return { statusCode, body: error.message };
  }
};
```

**API Gateway passes each claim as a string.** An HTTP API's JWT authorizer turns every claim value into a string before it calls the function. A number such as `exp` arrives as `"1700000000"`, and an array such as `["admin", "staff"]` arrives as `"[admin staff]"`. So a claims schema reads strings, and converts the ones that it needs as other types:

```ts [shared/claims.ts]
import * as v from "valibot";

export const Claims = v.object({
  sub: v.string(),
  exp: v.pipe(v.string(), v.transform(Number)),
  groups: v.optional(
    v.pipe(
      v.string(),
      v.transform((value) => value.slice(1, -1).split(" ").filter(Boolean)),
    ),
  ),
});
```

The AWS documentation shows the claims only as strings, and doesn't describe how other values are converted. Check the claims that your identity provider's tokens hold, by logging `event.requestContext.authorizer.jwt.claims` once.

The handler's event types `requestContext.authorizer.jwt.claims` as `JwtClaims`, the loose type from `aws-lambda`, which allows numbers, booleans and arrays that API Gateway doesn't send. Read the typed claims from the result of `decode()`.

### JwtAuthorizerConfig

```ts [@notation/aws/api-gateway]
type JwtAuthorizerConfig = {
  id: string;
  name?: string;
  api: ApiGroup;
  issuer: string;
  audience: string[];
  scopes?: string[];
  claims?: StandardSchemaV1;
};
```

`id` keys the authorizer in state, together with its API's `id`. The state key is `api-authorizer:<api id>:<id>`, such as `api-authorizer:todo-api:user-auth`. Use 1 to 64 letters, digits, hyphens and underscores, as a string literal. Two authorizers of one API can't share an `id`, but two APIs can each have an authorizer with the same `id`.

**The `issuer` and `audience` don't affect the state key.** Changing them updates the authorizer in place, and the routes keep pointing at it. Two authorizers on one API can have the same `issuer` and `audience` if their IDs differ. An HTTP API allows 10 authorizers.

In AWS, the authorizer is named after its `id`, such as `user-auth`, or after `name` when you set it. The name has no `<app>--<stage>--` prefix, because an authorizer's name only needs to be unique inside its API, and the API's name has the prefix already.

The authorizer owns its API Gateway authorizer resource. Each route of the authorizer requires its `scopes`.

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

const todoApi = api({ id: "todo-api" });
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
  event: () => apiGateway.schema(null),
});

const todos = await api.get<any[]>("/todos");

export const handler: LambdaHandler<typeof lambda> = async (event) => {
  if (event.routeKey === "GET /todos/count") return todos.length;
  return todos;
};
```

::

From these two files, Notation declares an API Gateway HTTP API and a deployment stage, one Lambda function with its IAM role, zip package and CloudWatch log group, one Lambda integration, one invoke permission, and two API Gateway routes. Both routes call the `todos` function, and its handler branches on `event.routeKey`.
