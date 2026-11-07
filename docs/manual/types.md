# End-to-End Types

A runtime module's declaration carries types to two places: to the infra code that wires the function, and to the function's own code. TypeScript checks both with the same declaration, in one project.

## Wiring is checked against the event

`event` in the declaration says which events the function receives. Infra APIs accept only a declaration whose event matches what they send:

::code-group

```ts [infra/api.ts]
import { api, router } from "@notation/aws/api-gateway";
import { lambda as orders } from "runtime/orders";

const myApi = api({ name: "order-api" });
const myRouter = router(myApi);
myRouter.get("/orders", () => orders); // type error: orders is an SQS Lambda
```

```ts [runtime/orders.ts]
import { $lambda, sqs, type LambdaHandler } from "@notation/aws/lambda";

export const lambda = $lambda({
  id: "orders",
  event: () => sqs(),
});

export const handler: LambdaHandler<typeof lambda> = async (event) => {
  for (const record of event.Records) console.log(record.body);
};
```

::

| Infra API                                          | Accepts a declaration with            |
| -------------------------------------------------- | ------------------------------------- |
| `queue.consume(target)`                            | `sqs()` or no `event`                 |
| `router.get(path, target)`                         | `http()` or no `event`                |
| `router.withJWTAuthorizer(auth).get(path, target)` | `http({ auth: jwt() })` or no `event` |
| `schedule({ target })`                             | `scheduled()` or no `event`           |

The infra APIs also check the event when infra runs, so a mismatch that TypeScript misses, such as one behind an `any`, fails with an error that names the Lambda and its event.

A Lambda group from `lambda()` has no event, so every infra API accepts it.

## The handler is typed from the declaration

`LambdaHandler<typeof lambda>` gives the handler the event type that the declaration names:

```ts [runtime/orders.ts]
export const handler: LambdaHandler<typeof lambda> = async (event) => {
  // event is an SQSEvent, because the declaration has event: () => sqs()
};
```

**The handler is checked only when you write the annotation.** A handler with no annotation, or written as `export async function handler(event: APIGatewayProxyEventV2)` in an SQS module, passes the build. The RFC plans a build-time check that `handler` satisfies `LambdaHandler<typeof lambda>`, but it isn't built.

## Bound values are typed by name

`lambda.env()` returns the values that the declaration binds in `env`, typed by name:

```ts [runtime/orders.ts]
export const lambda = $lambda({
  id: "orders",
  event: () => sqs(),
  env: () => ({ ORDER_QUEUE_URL: orderQueue.url }),
});

lambda.env().ORDER_QUEUE_URL; // string
lambda.env().ORDERS_URL; // type error: the declaration doesn't bind ORDERS_URL
```

`LambdaEnv<typeof lambda>` is the type of the values, for code that receives them as a parameter.

## Bodies are typed by the schema

`sqs(schema)` and `http({ body: schema })` take a [Standard Schema](https://standardschema.dev). `lambda.decode()` returns the schema's output type:

```ts [runtime/orders.ts]
export const lambda = $lambda({
  id: "orders",
  event: () => sqs(Order),
});

const order = await lambda.decode(record); // the output type of Order
```

Nothing checks the other end. A producer that sends to the queue isn't checked against `Order`, and the queue doesn't carry the schema. Message codecs, which would let Notation check senders and keep types such as `Date` across the queue, aren't built.

## JWT claims

A request through a route with a JWT authorizer holds the token's claims, so it is a different event from a plain HTTP request. The declaration says so with `http({ auth: jwt<Claims>() })`, and `LambdaHandler<typeof lambda>` types the claims as `Claims`:

::code-group

```ts [infra/api.ts]
import { api, router } from "@notation/aws/api-gateway";
import { lambda as user } from "runtime/user";

const myApi = api({ name: "user-api" });
const authedRouter = router(myApi).withJWTAuthorizer({
  type: "jwt",
  issuer: "https://auth.example.com/",
  audience: ["https://api.example.com"],
  scopes: [],
});

authedRouter.get("/user", () => user);
```

```ts [runtime/user.ts]
import { $lambda, http, jwt, type LambdaHandler } from "@notation/aws/lambda";

type JWTClaims = { sub: string; email: string };

export const lambda = $lambda({
  id: "user",
  event: () => http({ auth: jwt<JWTClaims>() }),
});

export const handler: LambdaHandler<typeof lambda> = async (event) => {
  const { sub, email } = event.requestContext.authorizer.jwt.claims;
  return { sub, email };
};
```

::

- The routes of `withJWTAuthorizer()` accept only a declaration with `http({ auth: jwt() })`, or one with no `event`. A plain router's routes reject it, because the request would have no claims.
- TypeScript doesn't check `JWTClaims` against the tokens that the issuer sends.
- `jwt()` doesn't hold the issuer or the audience. Those stay in infra, in `withJWTAuthorizer()`.
