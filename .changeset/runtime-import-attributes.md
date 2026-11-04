---
"@notation/resource": minor
"@notation/aws": minor
"@notation/core": minor
"@notation/esbuild-plugins": minor
"@notation/cli": minor
---

Runtime and infra modules import each other through import attributes, and runtime modules declare their functions with `lambda()` (RFC 0008).

- A runtime module imports infra `with { type: "infra" }`, and infra imports a runtime module `with { type: "runtime" }`. Importing a file that matches the `runtimeModules` globs without the attribute fails, as do `type: "infra"` in infra and `type: "runtime"` in runtime code.
- A runtime module imports `lambda` from `@notation/aws/lambda` with `{ type: "infra" }` and calls it without `code`: `const { handle } = lambda({ id: "checkout", timeout: 5, grants: [orderQueue.grant(["SendMessage"])] })`. Each handler that `handle` makes, and the module exports, belongs to that function. The `resource` export and `LambdaResource` are removed; a module that exports `resource` fails with a migration message. `@notation/aws/lambda.fn` no longer exports `handle`.
- Runtime modules run after all of infra, as stripped copies that keep only the `lambda()` calls, the handlers they make and what those reference. `lambda()` settings can use any infra value, and the plan doesn't depend on the order infra modules load.
- `route()`, `queue.consume()` and `schedule()` wire a handler when evaluation ends. `consume()` returns nothing. A handler of the wrong kind fails at the infra call site, and a handler that isn't exported fails at plan.
- `compile` writes `notation-env.d.ts`, evaluates the infra phase, then bundles each function to `dist/functions/<id>/index.mjs`, with a dispatcher to its handlers.
- `notation types` writes `notation-env.d.ts` at the project root. It has one block per attributed import specifier, and catch-all blocks for `./*` and `../*` that give an import with no block an error type. `notation watch` writes it again when a source file is created, deleted, moved or changed. The file needs TypeScript 7.1. Exclude it from Prettier and typescript-eslint.
- `@notation/resource` exports the view types `RuntimeView`, `InfraView`, `Handler`, `RuntimeRef`, `InfraOnly`, `RuntimeOnly`, `Grant` and `FunctionDeclaration`, which `@notation/core/types` re-exports. It also adds the linking API: `createStandIn`, `linkRuntimeModules`, `createHandlerRef`, `declareRuntimeFunction` and `resolveRuntimeTarget`. The resource graph has `runtimeFunctions`.
- `handle.<kind>(fn)` returns a `LambdaHandler`: a function with a type-only mark. Infra sees it as a `LambdaRef`, a `RuntimeRef` whose `function` is a `LambdaGroup`, and can wire it but not call it. An exported `lambda()` result is seen by infra as its `LambdaGroup`.
- `route()`, the router methods, `queue.consume()` and `schedule()` take a `LambdaRef` of the right event, or a Lambda group. A plain function, or a handler imported without the attribute, no longer type-checks.
- Runtime code reads infra values through a `type: "infra"` import of a local infra module. The function's bundle turns `orderQueue.url` into `read("infra/orders#orderQueue", ["url"])`, and a whole binding used as a value into a read of its data properties. `compile` lists the reads left after tree-shaking in `dist/functions/<id>/reads.json`, and plan and deploy deliver their values through the function's `Runtime` map, under output keys such as `infra/orders#orderQueue.url`. A read of an infra function, or of a value that isn't an output or data, fails at plan. Calling infra from runtime code, changing it, using a namespace import of it as a value, or importing an infra package without the attribute fails the build. `@notation/resource/outputs` exports `read`, `outputKey`, `parseOutputKey`, `setOutputValues` and `addOutputSource`.
- Runtime code sees a queue's `url` and `arn` as strings. It can call resource factories, such as `lambda()`, and `queue.grant()`, and no other infra function or method.
- `sqsBatch` and `dynamoDbBatch` handlers take the SQS or DynamoDB stream event and return the batch response.
