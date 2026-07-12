# Low-level `aws.lib` resource layer

**Idea:** A lower-level, granular AWS resource library (`@notation/aws.lib`) that models
primitives directly — e.g. API Gateway `api` / `route` / `stage` / `integration` /
`lambda-integration`, IAM `role-policy-attachment` — with a thin AWS `client`. Higher-level
`@notation/aws` builders would compose these primitives.

Minimal shape (relative to main):

- `packages/aws.lib/src/client.ts`, `resources.ts`, and `resources/**` (api-gateway/*, iam/*).

**Status:** exploratory. All-WIP branch; the value is the *layering idea* (primitive lib vs.
ergonomic builders), not the code.

**Source branch (archaeology):** `spike/aws-lib` (~2023-11).
