---
"@notation/resource": patch
---

Plan treats an output ref that `deriveParams` or a function contribution takes from a dependency, such as `deps.fn.outputRef("FunctionArn")`, as it treats any other output ref. When the dependency has no output, or its state record lacks the output, the param is shown as unknown. Before, plan failed with `PendingOutput`.
