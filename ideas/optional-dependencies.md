# Optional resource dependencies

**Idea:** Allow a resource's declared dependency to be absent, so infra graphs can be built
conditionally without a dependency always being required.

Minimal shape (relative to main), in `packages/core/src/orchestrator/resource.ts` (types have
since moved into `@notation/resource`, so re-target there):

- Widen the dependency map from `Record<string, BaseResource>` to
  `Record<string, BaseResource | void>`.
- Apply the same widening to `Resource<S, D, C>`, `SimpleResource`, and
  `requireDependencies<Dependencies>()`.

Trivial type-level change; the interesting work is deciding the runtime semantics of a
`void` dependency (skip wiring vs. error).

**Source branch (archaeology):** `iac/optional-deps` (one commit, ~2024-01).
