# API Gateway JWT authorizer

**Idea:** Add an authorizer resource for API Gateway plus a typed JWT handler contract,
so routes can be protected with a lambda authorizer.

Minimal shape (relative to main):

- `packages/aws.iac/src/resources/api-gateway/auth.ts` — authorizer IAC resource
- `packages/aws/src/api-gateway/auth.ts` — user-facing authorizer builder
- Shared JWT helper (`shared/jwt.ts` in the example) — handler returns a **promise-based**
  policy/response only (the old branch converged on rejecting sync returns).
- Example: `examples/api-gateway-authorizer/` (infra + `runtime/user.fn.ts`).

**Source branch (archaeology):** `api-authorizer` (~2024-01, much WIP). Reference only.
