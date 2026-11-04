---
"@notation/resource": minor
"@notation/aws": minor
"@notation/core": minor
"@notation/cli": minor
---

Infra and runtime code type each other through import attributes (RFC 0008).

- Infra imports a runtime module `with { type: "runtime" }`, and runtime code imports infra `with { type: "infra" }`.
- `notation types` writes `notation-env.d.ts` at the project root. It has one block per attributed import specifier, and catch-all blocks for `./*` and `../*` that give an import with no block an error type. `notation compile` writes the file first, and `notation watch` writes it again when a source file is created, deleted, moved or changed. The file needs TypeScript 7.1. Exclude it from Prettier and typescript-eslint.
- `@notation/resource` exports the view types `RuntimeView`, `InfraView`, `Handler`, `RuntimeRef`, `InfraOnly`, `RuntimeOnly`, `Grant` and `FunctionDeclaration`. `@notation/core/types` re-exports them.
- `handle.<kind>(fn)` returns a `LambdaHandler`: a function with a type-only mark, not a `RuntimeRef`. Infra sees it as a `RuntimeRef` with `function: LambdaGroup` through the generated declarations, and can wire it but not call it.
- `route()`, the router methods, `queue.consume()` and `schedule()` take a `LambdaRef` of the right event, or a Lambda group. A plain function, or a handler imported without the attribute, no longer type-checks.
- Runtime code sees a queue's `url` and `arn` as strings. It can call resource factories and `queue.grant()`, and no other infra function or method.
