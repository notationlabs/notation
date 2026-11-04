# End-to-End Types

Infra modules and runtime modules import each other, and each side needs a different view of the other. Infra needs a handler as a reference that it can wire to a route, not a function that it can call. Runtime code needs a queue's URL as a `string`, not as a token that infra fills in at deploy. [`notation types`](../cli/types.md) writes `notation-env.d.ts`, which gives each attributed import the view that its side needs. TypeScript then checks both directions.

## Type-safe handlers

When you wire a handler to an API Gateway route, TypeScript checks that the handler takes the route's event:

::code-group

```ts [infra/api.ts]
import { api, router } from "@notation/aws/api-gateway";
import { getUser } from "runtime/user.fn" with { type: "runtime" };

const myRouter = router(api({ name: "user-api" }));
myRouter.get("/user", getUser);
```

```ts [runtime/user.fn.ts]
import { json } from "@notation/aws/lambda.fn";
import { lambda } from "@notation/aws/lambda" with { type: "infra" };

const { handle } = lambda({ id: "user", timeout: 5 });

export const getUser = handle.apiRequest((event) => {
  return json({ id: 1, name: "Alice" });
});
```

::

`handle.apiRequest` types `event` as an API Gateway v2 HTTP event. Infra imports the runtime module `with { type: "runtime" }`, so it sees `getUser` as a `RuntimeRef`:

```ts [@notation/resource]
type RuntimeRef<Event, Result, Function> = {
  readonly function: Function;
};
```

Infra can pass a `RuntimeRef` to the router, but it can't call it. Infra's view of a runtime module follows these rules:

| Export of the runtime module                     | In infra                                                        |
| ------------------------------------------------ | --------------------------------------------------------------- |
| A handler made with `handle.*`                   | A `RuntimeRef`. `getUser.function` is its Lambda group.         |
| The result of `lambda()`                         | The Lambda group                                                |
| Anything else, such as a helper or a constant    | A type that infra can't use                                     |

Each infra API takes a `RuntimeRef` of the event it sends. So these are type errors, at the line you wrote:

- `getUser(event)` in infra: a `RuntimeRef` isn't callable.
- `orderQueue.consume(getUser)`: `consume` sends SQS events, and `getUser` takes API Gateway events.

Runtime code has its own view of infra. See [Reading Infra Values](./infra-values.md).

## JWT authorizer types

When you use a JWT authorizer, the claims type flows from infra to the handler:

::code-group

```ts [infra/api.ts]
import { api, router } from "@notation/aws/api-gateway";
import { getUser } from "runtime/user.fn" with { type: "runtime" };
import type { JWTClaims } from "shared/jwt";

const authedRouter = router(api({ name: "user-api" })).withJWTAuthorizer<JWTClaims>({
  type: "jwt",
  issuer: "https://auth.example.com/",
  audience: ["https://api.example.com"],
  scopes: [],
});

authedRouter.get("/user", getUser);
```

```ts [runtime/user.fn.ts]
import { json } from "@notation/aws/lambda.fn";
import { lambda } from "@notation/aws/lambda" with { type: "infra" };
import type { JWTClaims } from "shared/jwt";

const { handle } = lambda({ id: "user", timeout: 5 });

export const getUser = handle.jwtAuthorizedApiRequest<JWTClaims>((event) => {
  // event.requestContext.authorizer.jwt.claims is typed as JWTClaims
  const { sub, email } = event.requestContext.authorizer.jwt.claims;
  return json({ sub, email });
});
```

::

A router with a JWT authorizer takes only handlers for the same claims type. The same pattern applies to the other event sources: EventBridge, DynamoDB streams and SQS. Each `handle.*` method types the event to match its source.

## The generated declarations

Each block in `notation-env.d.ts` reads the types of the real module, so adding, removing or renaming an export updates both views without a new run of `notation types`. The file needs TypeScript 7.1 or later. See [notation types](../cli/types.md).

## Renaming a handler

**An editor rename that starts in the runtime module doesn't reach infra.** If you rename `getUser` in `runtime/user.fn.ts`, the editor updates that module and its tests, but not `getUser` in `infra/api.ts`. Infra then fails to type-check with `TS2339 Property 'getUser' does not exist`, or a missing export error for a named import.

A rename that starts in infra updates every file. So rename handlers from the infra module that imports them.

## Errors that types can't catch

Some mistakes type-check, and fail the build or the plan instead:

- A call to infra inside a handler, such as `orderQueue.grant()`. See [Grants](./function-config.md#grants).
- An infra method stored in a variable, such as `const g = orderQueue.grant`.
- A handler that no runtime module exports.
