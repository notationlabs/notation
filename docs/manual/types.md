# End-to-End Types

A runtime module's declaration carries types to two places: to the infra code that wires the function, and to the function's own code. TypeScript checks both with the same declaration, in one project.

## Wiring is checked against the event

`event` in the declaration says which events the function receives. Infra APIs accept only a declaration whose event matches what they send:

::code-group

```ts [infra/api.ts]
import { api, router } from "@notation/aws/api-gateway";
import { lambda as orders } from "runtime/orders";

const myApi = api({ id: "order-api" });
const myRouter = router(myApi);
myRouter.get("/orders", () => orders); // type error: orders is an SQS Lambda
```

```ts [runtime/orders.ts]
import { $lambda, sqs, type LambdaHandler } from "@notation/aws/lambda";
import { Order } from "shared/schema";

export const lambda = $lambda({
  id: "orders",
  event: () => sqs.schema(Order),
});

export const handler: LambdaHandler<typeof lambda> = async (event) => {
  for (const record of event.Records) console.log(record.body);
};
```

::

| Infra API                                       | Accepts a declaration with                                                                                                         |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `eventSourceMapping({ source, target })`        | `sqs.schema()` of the queue's schema type, or no `event`                                                                           |
| `router.get(path, target)`                      | `apiGateway.schema(body)`, or no `event`                                                                                           |
| `router.withAuthorizer(auth).get(path, target)` | `apiGateway.schema(body).authSchema(claims)` of the authorizer's claims type, `.authSchema()` with no claims schema, or no `event` |
| `schedule({ target })`                          | `eventBridge.schedule()` or no `event`                                                                                             |

The infra APIs also check the event when infra runs, so a mismatch that TypeScript misses, such as one behind an `any`, fails with an error that names the Lambda and its event.

A Lambda group from `lambda()` has no event, so every infra API accepts it.

## The handler is typed from the declaration

`LambdaHandler<typeof lambda>` gives the handler the event type that the declaration names:

```ts [runtime/orders.ts]
export const handler: LambdaHandler<typeof lambda> = async (event) => {
  // event is an SQSEvent, because the declaration has event: () => sqs.schema(Order)
};
```

**The handler is checked only when you write the annotation.** A handler with no annotation, or written as `export async function handler(event: APIGatewayProxyEventV2)` in an SQS module, passes the build. The RFC plans a build-time check that `handler` satisfies `LambdaHandler<typeof lambda>`, but it isn't built.

## Bound values are typed by name

`lambda.env()` returns the values that the declaration binds in `env`, typed by name:

```ts [runtime/orders.ts]
export const lambda = $lambda({
  id: "orders",
  event: () => sqs.bind(orderQueue),
  env: () => ({ ORDER_QUEUE_URL: orderQueue.url }),
});

lambda.env().ORDER_QUEUE_URL; // string
lambda.env().ORDERS_URL; // type error: the declaration doesn't bind ORDERS_URL
```

`LambdaEnv<typeof lambda>` is the type of the values, for code that receives them as a parameter.

## Bodies are typed by the schema

`queue({ schema })`, `apiGateway.schema(body)` and the `schema` option of `defineRoute()` take a [Standard Schema](https://standardschema.dev). A declaration with `sqs.bind(queue)` gets the queue's schema, and `body` in the result of `lambda.decode()` has the schema's output type:

::code-group

```ts [runtime/orders.ts]
import { orderQueue } from "infra/orders";

export const lambda = $lambda({
  id: "orders",
  event: () => sqs.bind(orderQueue),
});

const { body: order } = await lambda.decode(record); // the output type of Order
```

```ts [infra/orders.ts]
import { Order } from "shared/schema";

export const orderQueue = queue({ id: "orders", schema: Order });
```

::

A declaration that infra maps queues to names the schema itself, with `sqs.schema(Order)`, and `body` has the output type of `Order`. `eventSourceMapping()` takes the declaration only if its schema has the type of the queue's schema:

```ts [infra/orders.ts]
import { lambda as orders } from "runtime/orders"; // event: () => sqs.schema(Order)
import { lambda as refunds } from "runtime/refunds"; // event: () => sqs.schema(Refund)

export const orderQueue = queue({ id: "orders", schema: Order });

eventSourceMapping({ source: orderQueue, target: () => orders });
eventSourceMapping({ source: orderQueue, target: () => refunds }); // type error: Refund is not Order
```

TypeScript compares the types of the schemas, so two schemas with the same type pass. When infra runs, `eventSourceMapping()` also checks that the queue's schema and the declaration's schema are the same object.

Nothing checks the other end. A producer that sends to the queue isn't checked against `Order`. Message codecs, which would let Notation check senders and keep types such as `Date` across the queue, aren't built.

## JWT claims

A request through a route with a JWT authorizer holds the token's claims, so it is a different event from a request through a route with no authorizer. The authorizer holds a schema for the claims, and the declaration takes it from the authorizer, or names the same schema with `.authSchema()`:

::code-group

```ts [infra/api.ts]
import { api, jwtAuthorizer, router } from "@notation/aws/api-gateway";
import { lambda as profile } from "runtime/profile";
import { Claims } from "shared/claims";

export const userApi = api({ id: "user-api" });
export const userAuth = jwtAuthorizer({
  id: "user-auth",
  api: userApi,
  issuer: "https://auth.example.com/",
  audience: ["https://api.example.com"],
  claims: Claims,
});

router(userApi)
  .withAuthorizer(userAuth)
  .get("/profile", () => profile);
```

```ts [runtime/profile.ts]
import { $lambda, apiGateway, type LambdaHandler } from "@notation/aws/lambda";
import { Claims } from "shared/claims";

export const lambda = $lambda({
  id: "profile",
  event: () => apiGateway.schema().authSchema(Claims),
});

export const handler: LambdaHandler<typeof lambda> = async (event) => {
  const { claims } = await lambda.decode(event); // the output type of Claims
  return { sub: claims.sub };
};
```

::

- The routes of `withAuthorizer()` accept only a declaration with a claims schema of the authorizer's claims type, a declaration with `.authSchema()` and no claims schema, or one with no `event`. A plain router's routes reject a declaration with `.authSchema()`, because the request would have no claims.
- When infra runs, the routes also check that the two claims schemas are the same object.
- `decode()` returns the validated claims as `claims`, with the output type of `Claims`. The handler's event still types `requestContext.authorizer.jwt.claims` as the loose `JwtClaims` from `aws-lambda`, because the event holds them as the token does. With `.authSchema()` and no claims schema, `claims` has the type `JwtClaims`.
- A declaration that makes its own route with `apiGateway.bind(userApi).defineRoute({ ..., auth: userAuth })` takes the claims schema from `userAuth`, so there is nothing to compare.
