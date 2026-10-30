---
"@notation/resource": minor
"@notation/reconciler": minor
"@notation/core": minor
"@notation/utils": minor
---

A schema item can declare `collect`, and any code can add to that param with `resource.contribute(values, { by })` while infra is being evaluated. Contributions are combined in an order sorted by content, and a conflict names both contributors. `mergeContributions` merges maps key by key. `resource.outputValue(key)` returns a token that config and contributions can hold, including inside a template string. The token makes its holder depend on the resource it came from, and deploy fills in the real value. `resource.dependOn(other)` adds a dependency after construction. Contributions close when evaluation ends, and `onEvaluationEnd` registers a callback that runs before the close. Plan marks a value that waits on an undeployed output unknown at its own path, and gives `deriveParams` tokens for the output of a dependency that has none yet. `BaseResource` gains `contribute`, `dependOn`, `getDependencies`, `planParams` and `outputValue`. `@notation/utils` adds `sortedJson`, JSON with sorted keys.
