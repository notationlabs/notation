# Alternative lambda runtimes

**Idea:** Let a lambda declare a non-default runtime (e.g. Python) instead of assuming Node,
so external/pre-built handlers in other languages can be deployed.

Minimal shape (relative to main):

- `packages/aws.iac/src/resources/lambda/lambda.ts` — expose the `Runtime` param instead of
  hard-coding it.
- `packages/aws/src/lambda/lambda.ts` — thread an optional `runtime` through the builder.
- Example: `examples/lambda-external/external/lambda.py` wired via `infra/lambda.ts`.

**Source branch (archaeology):** `lambda-runtimes` (~2025-02, small & focused — the cleanest
of the stale branches; could be re-implemented quickly against current main).
