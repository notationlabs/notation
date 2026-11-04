---
"@notation/resource": minor
"@notation/aws": minor
"@notation/esbuild-plugins": minor
"@notation/cli": minor
---

Runtime modules declare their functions with `lambda()` (RFC 0008, infra phase).

- A runtime module imports `lambda` from `@notation/aws/lambda` with `{ type: "infra" }` and calls it without `code`: `const { handle } = lambda({ id: "checkout", timeout: 5, grants: [orderQueue.grant(["SendMessage"])] })`. Each handler that `handle` makes, and the module exports, belongs to that function. The `resource` export and `LambdaResource` are removed; a module that exports `resource` fails with a migration message.
- Infra imports a runtime module with `{ type: "runtime" }`. Importing a file that matches the `runtimeModules` globs without it fails, as do `type: "infra"` in infra and `type: "runtime"` in runtime code.
- Runtime modules run after all of infra, as stripped copies that keep only the `lambda()` calls, the handlers they make and what those reference. `lambda()` settings can use any infra value, and the plan doesn't depend on the order infra modules load.
- `route()`, `queue.consume()` and `schedule()` wire a handler when evaluation ends. `consume()` returns nothing. A handler of the wrong kind fails at the infra call site, and a handler that isn't exported fails at plan.
- `compile` evaluates the infra phase, then bundles each function to `dist/functions/<id>/index.mjs`, with a dispatcher to its handlers.
- `@notation/resource` adds the linking API: `createStandIn`, `linkRuntimeModules`, `createHandlerRef`, `declareRuntimeFunction`, `resolveRuntimeTarget`, and the `Handler` and `RuntimeRef` types. The resource graph has `runtimeFunctions`.
