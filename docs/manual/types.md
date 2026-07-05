# End-to-End Types

Notation's type system spans infrastructure definitions and runtime handlers, catching mismatches before deployment.

## Type-safe handlers

When you wire a handler to an API Gateway route, TypeScript ensures the handler's signature matches the expected event shape:

::code-group

```ts [infra/api.ts]
import { api, router } from "@notation/aws/api-gateway";
import { getUser } from "runtime/user.fn";

const myApi = api({ name: "user-api" });
const myRouter = router(myApi);
myRouter.get("/user", getUser);
```

```ts [runtime/user.fn.ts]
import { handle, json } from "@notation/aws/lambda.fn";

export const getUser = handle.apiRequest((event) => {
  return json({ id: 1, name: "Alice" });
});
```

::

The `handle.apiRequest` wrapper types `event` as an API Gateway v2 HTTP event. If you pass a handler with the wrong event type to the router, TypeScript catches it at compile time.

## JWT authorizer types

When using a JWT authorizer, claims types flow from infrastructure to handler:

::code-group

```ts [infra/api.ts]
import { api, router } from "@notation/aws/api-gateway";
import { getUser } from "runtime/user.fn";

type JWTClaims = { sub: string; email: string };

const myApi = api({ name: "user-api" });
const authedRouter = router(myApi).withJWTAuthorizer<JWTClaims>({
  type: "jwt",
  issuer: "https://auth.example.com/",
  audience: ["https://api.example.com"],
  scopes: [],
});

authedRouter.get("/user", getUser);
```

```ts [runtime/user.fn.ts]
import { handle, json } from "@notation/aws/lambda.fn";

export const getUser = handle.jwtAuthorizedApiRequest<JWTClaims>((event) => {
  // event.requestContext.authorizer.jwt.claims is typed as JWTClaims
  const { sub, email } = event.requestContext.authorizer.jwt.claims;
  return json({ sub, email });
});
```

::

The same pattern applies to other event sources (EventBridge, DynamoDB streams, SQS). Each `handle.*` wrapper types the event to match its source.
