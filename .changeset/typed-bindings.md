---
"@notation/build": minor
"@notation/cloudflare": minor
"@notation/resource": minor
---

`$worker` takes `entrypoint`, the class that the module exports as its default. A Worker that binds it gets `Service<Class>` in `env` when the class is a `WorkerEntrypoint`, so its RPC calls are typed, and a `Fetcher` otherwise. `Worker` has a second type parameter for the class. The build fails when `entrypoint` is not the class that the module declares and exports as its default, or when the module declares the class after `$worker`.

- `worker()` takes `entrypoint` as a marker from `entrypointType<typeof Class>()`, which `@notation/cloudflare/workers` exports. The build doesn't check the marker.
- `addBindings(worker, bindings)` adds bindings to a Worker from `$worker` or `worker()` from other infra code. The Worker resolves them with its own bindings. `WorkerEnv` doesn't include them. It fails for a name that is bound twice, and when it is called from an `onEvaluationEnd` callback.
- A `@declaration` mark takes an `entryOption` clause, which names the option whose value must be the module's `entry` export.
- `@notation/resource` exports `evaluationEnded()`, which is `true` once the collection has started to run its `onEvaluationEnd` callbacks, and `captureCallSiteLazily()`.
- The build reads the name of a default-exported declaration, such as `export default function greeting() {}`. The infra build of a declaration module keeps such a function or class when the declaration uses it, where it dropped it before. The check for type-only exports counts the name as a value.
