---
type: epic
title: "@notation/serverless-router"
created: "2026-02-26T00:56:53.959Z"
updated: "2026-02-26T00:56:53.959Z"
tasks:
  - TASK-012
priority: medium
estimate: medium
---
## Express-like DSL that generates cloud infrastructure, not HTTP handling.

## Why

`router.get("/todos", handler)` is the most information-dense line in the Notation codebase. From it, the framework infers: an API Gateway route, a Lambda integration, an IAM permission linking the two, and optionally a JWT authorizer — all with correct dependency edges. That is 3-5 interconnected cloud resources from one line. This is what "compression" means: the complete set of valid configurations, derived from minimal input.

Traditional routers (`Express`, `Hono`, `Fastify`) operate at **runtime** — they receive HTTP requests and dispatch them. This router operates at **build time** — it constructs an infrastructure graph. The familiar verb-based DSL (`get`, `post`, `put`, `delete`) is not ergonomic sugar for request handling, it is ergonomic sugar for cloud resource wiring.

This matters because:

1. **Routing IS infrastructure.** In serverless, every route is a separately deployed resource with its own permissions, integration, and auth config. Treating this as a runtime concern means your infrastructure and your routing logic are defined in two different places. This package unifies them.
2. **The API compresses complexity.** Without this DSL, adding a route means manually creating and wiring 3-5 resources with correct cross-references. With it, you write one line. The compression ratio is real, not just syntactic.
3. **Provider-agnostic by design.** The `RouterAdapter` interface means the same `router.get("/todos", handler)` can target AWS API Gateway, GCP Cloud Run, or any future provider. The routing intent is portable; only the infrastructure wiring changes.

---

## What to extract

### From `packages/aws/src/api-gateway/`

| File | What to extract |
|---|---|
| `router.ts` | The `router()` factory, `AuthorizedRouteBuilder` class, the `createRouteCallback` pattern |
| `route.ts` | The `route()` function orchestration logic (resource group creation, dependency wiring, idempotent resource addition) |
| `auth.ts` | `AuthorizerConfig`, `JWTAuthorizerConfig`, `Unauthenticated`, `NO_AUTH` |
| `utils.ts` | AWS-specific mapping — belongs in a provider adapter |

## What to leave behind

1. All `@notation/aws.iac` resource classes — these are the concrete infrastructure nodes; the router just wires them.
2. `AwsResourceGroup` — use abstract `ResourceGroup` from `@notation/core`.
3. The `api()` factory — each provider needs its own gateway factory.
4. The `lambda()` factory — compute-provider concern, not routing.
5. AWS SDK types.

## API surface

### Provider-agnostic core

```ts
export interface RouterAdapter<THandler, TAuthorizedHandler> {
  createRoute(
    gateway: ResourceGroup,
    method: HttpMethod,
    path: string,
    auth: AuthorizerConfig,
    handler: THandler | TAuthorizedHandler,
  ): ResourceGroup;
}

export const router = <THandler, TAuthorizedHandler>(
  gateway: ResourceGroup,
  adapter: RouterAdapter<THandler, TAuthorizedHandler>,
) => ({
  get: createRouteCallback("GET"),
  post: createRouteCallback("POST"),
  put: createRouteCallback("PUT"),
  patch: createRouteCallback("PATCH"),
  delete: createRouteCallback("DELETE"),
  withJWTAuthorizer: <ClaimsType>(auth: JWTAuthorizerConfig) => { ... },
});
```

### Usage (before and after)

Before: `import { api, router } from "@notation/aws/api-gateway";`
After: `import { router } from "@notation/serverless-router";`

Convenience re-export in `@notation/aws` preserves backwards compatibility — existing user code requires zero changes.

## Key design decisions

1. **Routing is infrastructure, not runtime.** `handler` is a reference to a function resource group, not an executable function.
2. **`RouterAdapter` as the provider seam.** Single `createRoute` method. All provider-specific logic lives in the adapter.
3. **`AuthorizedRouteBuilder` pattern.** `withJWTAuthorizer<ClaimsType>()` returns a new router-like object. Carries auth config as closure state, preserves TypeScript generic type flow.
4. **Idempotent resource addition.** A single handler mounted on multiple routes does not create duplicate permissions/integrations.
5. **Handler type parameterization.** Router is generic over `<THandler, TAuthorizedHandler>` for compile-time type checking.

## Dependencies

| Dependency | Reason |
|---|---|
| `@notation/core` | `ResourceGroup` base class |

One dependency. The core router is ~110 lines.