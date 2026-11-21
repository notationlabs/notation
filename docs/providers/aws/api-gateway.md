# API Gateway

Expose public or JWT-authenticated HTTP endpoints backed by AWS API Gateway v2 HTTP APIs and Lambda proxy integrations.

For AWS credential and region setup, see [AWS Overview](./overview.md).

Define a shared payload schema, a `$lambda` HTTP handler, and an API Gateway router that wires `POST /orders` to that function:

::code-group

```ts [runtime/create-order.ts]
import { $lambda, apiGateway, DecodeError, type LambdaHandler } from "@notation/aws/lambda";
import { NewOrder } from "../shared/orders";

export const createOrder = $lambda({
  id: "create-order",
  event: () => apiGateway.schema(NewOrder),
});

export const handler: LambdaHandler<typeof createOrder> = async (event) => {
  try {
    const { body: order } = await createOrder.decode(event);
    return { statusCode: 201, body: JSON.stringify({ orderId: order.orderId }) };
  } catch (error) {
    if (!(error instanceof DecodeError)) throw error;
    return { statusCode: 400, body: JSON.stringify({ issues: error.issues }) };
  }
};
```

```ts [infra/api.ts]
import { api, router } from "@notation/aws/api-gateway";
import { createOrder } from "../runtime/create-order";

export const ordersApi = api({ id: "orders-api" });
router(ordersApi).post("/orders", () => createOrder);
```

```ts [shared/orders.ts]
import * as v from "valibot";

export const NewOrder = v.object({
  orderId: v.string(),
  quantity: v.pipe(v.number(), v.integer(), v.minValue(1)),
});
```

::

Each `api()` call provisions an HTTP API (`ProtocolType: "HTTP"`) with an auto-deploying `$default` stage serving from the root URL. Handlers can return either a structured HTTP response (`{ statusCode, headers?, body?, cookies?, isBase64Encoded? }`) or a JSON-serializable object returned with status `200`.

## Multiple routes

Route multiple HTTP paths on `router(ordersApi)` to one `$lambda` handler and dispatch on `event.routeKey`:

::code-group

```ts [runtime/orders.ts]
import { $lambda, apiGateway, DecodeError, type LambdaHandler } from "@notation/aws/lambda";
import { NewOrder } from "../shared/orders";

export const orders = $lambda({
  id: "orders",
  event: () => apiGateway.schema(NewOrder),
});

export const handler: LambdaHandler<typeof orders> = async (event) => {
  if (event.routeKey === "GET /orders/{id}") {
    return { orderId: event.pathParameters?.id };
  }
  if (event.routeKey === "POST /orders") {
    try {
      const { body } = await orders.decode(event);
      return { statusCode: 201, body: JSON.stringify(body) };
    } catch (error) {
      if (!(error instanceof DecodeError)) throw error;
      return { statusCode: 400, body: JSON.stringify({ issues: error.issues }) };
    }
  }
  return { items: [] };
};
```

```ts [infra/api.ts]
import { api, router } from "@notation/aws/api-gateway";
import { orders } from "../runtime/orders";

const ordersApi = api({ id: "orders-api" });
const ordersRouter = router(ordersApi);

ordersRouter.get("/orders", () => orders);
ordersRouter.get("/orders/{id}", () => orders);
ordersRouter.post("/orders", () => orders);
```

```ts [shared/orders.ts]
import * as v from "valibot";

export const NewOrder = v.object({
  orderId: v.string(),
  quantity: v.pipe(v.number(), v.integer(), v.minValue(1)),
});
```

::

When one `$lambda` serves both bodyless `GET` and JSON `POST` routes, call `decode(event)` only in the `POST` branch. Paths support parameter templates like `"/orders/{id}"` and greedy segments like `"/orders/{proxy+}"` via `event.pathParameters`, leaving path and query parameters as raw string maps.

## Declaration-owned routes

Use `apiGateway.bind(api).defineRoute()` inside `$lambda` when a runtime module owns a single route alongside its handler:

::code-group

```ts [runtime/get-order.ts]
import { $lambda, apiGateway, DecodeError, type LambdaHandler } from "@notation/aws/lambda";
import { ordersApi } from "../infra/api";

export const getOrder = $lambda({
  id: "get-order",
  event: () =>
    apiGateway.bind(ordersApi).defineRoute({
      method: "GET",
      path: "/orders/{id}",
      schema: null,
    }),
});

export const handler: LambdaHandler<typeof getOrder> = async (event) => {
  try {
    await getOrder.decode(event);
    return { orderId: event.pathParameters?.id };
  } catch (error) {
    if (!(error instanceof DecodeError)) throw error;
    return { statusCode: 400, body: error.message };
  }
};
```

```ts [infra/api.ts]
import { api } from "@notation/aws/api-gateway";

export const ordersApi = api({ id: "orders-api" });
```

::

Pass `schema: null` on routes that must reject non-empty request bodies. Self-bound `defineRoute()` targets cannot also be wired through `router()`.

## JWT authorization

Use `jwtAuthorizer()` to validate bearer tokens in `$request.header.Authorization` at API Gateway before requests reach your Lambda functions:

::code-group

```ts [runtime/customer-orders.ts]
import { $lambda, apiGateway, DecodeError, type LambdaHandler } from "@notation/aws/lambda";
import { OrderClaims } from "../shared/jwt";

export const customerOrders = $lambda({
  id: "customer-orders",
  event: () => apiGateway.schema(null).authSchema(OrderClaims),
});

export const handler: LambdaHandler<typeof customerOrders> = async (event) => {
  try {
    const { claims } = await customerOrders.decode(event);
    return { customerId: claims.sub, expiresAt: claims.exp };
  } catch (error) {
    if (!(error instanceof DecodeError)) throw error;
    return { statusCode: error.part === "claims" ? 403 : 400, body: error.message };
  }
};
```

```ts [infra/api.ts]
import { api, jwtAuthorizer, router } from "@notation/aws/api-gateway";
import { customerOrders } from "../runtime/customer-orders";
import { OrderClaims } from "../shared/jwt";

export const ordersApi = api({ id: "orders-api" });

export const ordersAuth = jwtAuthorizer({
  id: "orders-auth",
  api: ordersApi,
  issuer: "https://auth.example.com/",
  audience: ["https://orders.example.com"],
  scopes: ["orders:read"],
  claims: OrderClaims,
});

router(ordersApi).withAuthorizer(ordersAuth).get("/orders", () => customerOrders);
```

```ts [shared/jwt.ts]
import * as v from "valibot";

// API Gateway passes every JWT claim value as a string.
export const OrderClaims = v.object({
  sub: v.string(),
  exp: v.pipe(v.string(), v.transform(Number)),
  scope: v.string(),
});
```

::

API Gateway HTTP APIs stringify all JWT claim values (including numbers and booleans), so use schema transforms when you need typed non-string claims (see [Types](../../core/types.md)). Branch on `error.part === "claims"` to return `403` for invalid claims and `400` for invalid bodies.

## Endpoint outputs

`api()` returns an `ApiGroup` exposing the underlying `Api` resource at `.api` (there is no `.url` shorthand). Read the deployed base URL via `.api.outputRef("ApiEndpoint")` or compose paths with `text` (see [Outputs & Contributions](../../core/outputs-and-contributions.md)):

```ts [infra/webhooks.ts]
import { api } from "@notation/aws/api-gateway";
import { lambda } from "@notation/aws/lambda";
import { text } from "@notation/resource";

export const ordersApi = api({ id: "orders-api" });

export const webhook = lambda({
  id: "webhook",
  code: { type: "file", path: "external/webhook.mjs" },
});

webhook.fn.contribute({
  Environment: {
    Variables: {
      API_BASE_URL: ordersApi.api.outputRef("ApiEndpoint"),
      ORDERS_URL: text`${ordersApi.api.outputRef("ApiEndpoint")}/orders`,
    },
  },
});
```

You can also inspect `ApiEndpoint` as a clickable link in [notation dashboard](../../cli/dashboard.md).

## CORS

`api({ id })` accepts only `id`, and `.api.contribute()` does not support `CorsConfiguration`. Return `Access-Control-Allow-Origin` headers from your Lambda handlers for simple requests, or declare low-level `apiGateway.Api` and `apiGateway.Stage` resources from `@notation/aws/resources` when API-level `OPTIONS` preflight handling is required:

```ts [infra/cors-api.ts]
import { apiGateway } from "@notation/aws/resources";

export const publicApi = new apiGateway.Api("api:public-api", {
  config: {
    ProtocolType: "HTTP",
    CorsConfiguration: {
      AllowOrigins: ["https://shop.example.com"],
      AllowMethods: ["GET", "POST", "OPTIONS"],
      AllowHeaders: ["content-type", "authorization"],
      AllowCredentials: true,
      MaxAge: 300,
    },
  },
});

export const publicStage = new apiGateway.Stage("api:public-api:stage", {
  config: { StageName: "$default", AutoDeploy: true },
  dependencies: { api: publicApi },
});
```

## Reference

### API options

`api(config)` accepts `{ id }` (`NameSafe<Id>`, `1` to `64` characters matching `[A-Za-z0-9_-]`; changing `id` replaces the API) and returns an `ApiGroup` containing an `Api` (`ProtocolType: "HTTP"`) and an auto-deploying `$default` `Stage`. Access the underlying `Api` resource via `.api` (`outputRef("ApiEndpoint")`, `outputRef("ApiId")`, `outputRef("ExecuteApiSourceArn")`).

### Router methods

`router(apiGroup)` exposes `.get(path, target)`, `.post(path, target)`, `.put(path, target)`, `.patch(path, target)`, `.delete(path, target)`, and `.withAuthorizer(authorizer)`:

- **`path`** (`` `/${string}` ``, required) – Route path starting with `/`, supporting parameter templates such as `"/orders/{id}"` and greedy paths such as `"/orders/{proxy+}"`.
- **`target`** (`ApiGatewayTarget`, required) – A `() => fn` thunk returning a `$lambda` declaration (with `apiGateway.schema(...)` or no `event`), or a `LambdaGroup` from `lambda()`.

Router validation and integration rules:

- **Shared integrations** – Multiple routes on one API targeting the same Lambda share one `LambdaIntegration` and one `LambdaPermission`; routes across two APIs create one pair per API.
- **Unique routes** – Duplicate `METHOD /path` routes on the same API, non-HTTP `$lambda` triggers, and self-bound `defineRoute()` targets throw.

### Route options

`apiGateway.bind(api).defineRoute(options)` accepts four options:

| Option | Description |
| :--- | :--- |
| `method` | Required HTTP method: `"GET"`, `"POST"`, `"PUT"`, `"PATCH"`, or `"DELETE"` |
| `path` | Required route path starting with `/` |
| `schema` | Required `StandardSchemaV1` body validator, or `null` for bodyless routes |
| `auth` | Optional `JwtAuthorizerGroup` created by `jwtAuthorizer()` on the same `api` |

### JWT authorizer options

`jwtAuthorizer(config)` creates a `JwtAuthorizerGroup`:

| Option | Description |
| :--- | :--- |
| `id` | Required `IdOption<Id>` scoped to the API |
| `name` | Optional AWS authorizer name override; defaults to `id` |
| `api` | Required `ApiGroup` whose routes this authorizer guards |
| `issuer` | Required OIDC or JWT issuer URL mapped to `JwtConfiguration.Issuer` |
| `audience` | Required `string[]` of allowed JWT audiences mapped to `JwtConfiguration.Audience` |
| `scopes` | Optional `string[]` of required OAuth scopes; defaults to `[]` |
| `claims` | Optional `StandardSchemaV1` validator used by `decode()` on JWT claims |

`jwtAuthorizer()` sets `IdentitySource` to `["$request.header.Authorization"]` and `AuthorizerType` to `"JWT"`. `id` must be `1` to `64` name-safe characters (changing it replaces the authorizer), and `name` omits the stage prefix.

`JwtAuthorizerGroup` (detectable via `isJwtAuthorizerGroup()`) exposes `.api`, `.auth` (`AuthInstance`), `.claims`, and `.scopes`.

| Rule | Behavior |
| :--- | :--- |
| Same API required | `withAuthorizer(auth)` and `defineRoute({ auth })` throw if `auth` belongs to another API |
| Unique name per API | Both `id` and `name ?? id` must be unique within an API |
| Auth mode match | Public routes reject `.authSchema(...)` and protected routes reject `apiGateway.schema(body)` |
| Claims schema identity | Authorizer and `.authSchema()` schemas must reference the same validator instance when both are set |
| Unchecked claims | Omitting `claims` or calling `.authSchema()` with no arguments returns raw `JwtClaims` |

### Request decoding

Calling `await fn.decode(event)` runs these steps in order:

1. **JWT claims** – Validates `requestContext.authorizer.jwt.claims` on `apiGateway-jwt` events, throwing `DecodeError` (`part: "claims"`) on failure.
2. **Base64 decoding** – Decodes `event.body` from base64 to UTF-8 when `isBase64Encoded` is `true`.
3. **Null body schema** – Rejects non-empty bodies with `DecodeError` (`part: "body"`) when `schema` is `null`.
4. **Standard Schema body** – Parses JSON bodies (or passes `undefined` when empty) and validates against the schema.
5. **Decoded result** – Returns `{ ...event, body }` (plus `claims` on protected routes), preserving request metadata.

### Payload responses

Lambda integrations use `PayloadFormatVersion: "2.0"`. `LambdaHandler<typeof fn>` types `event` as `APIGatewayProxyEventV2` (or `APIGatewayJWTProxyEventV2<JwtClaims>` for protected routes) and the return type as `ApiGatewayResult`.

### Standalone handler types

When deploying external handlers with `lambda()`, `@notation/aws/lambda` exports:

| Type | Description |
| :--- | :--- |
| `ApiGatewayHandler` | `(event: APIGatewayProxyEventV2, context: Context) => ApiGatewayResult \| Promise<ApiGatewayResult>` |
| `JWTAuthorizedApiGatewayHandler<ClaimsType>` | Handler typed with `APIGatewayJWTProxyEventV2<ClaimsType>` |
| `APIGatewayJWTProxyEventV2<T>` | HTTP v2 event with `requestContext.authorizer.jwt.claims` typed as `T` |
| `JwtClaims` | Raw API Gateway JWT claims map |
