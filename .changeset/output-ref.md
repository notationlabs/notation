---
"@notation/resource": minor
"@notation/aws": minor
---

`resource.outputValue(key)` is now `resource.outputRef(key)`. It returns an object that names a resource and one of its outputs, and does not hold the output, so the old name was misleading. The exports from `@notation/resource` are renamed to match:

- `OutputValue` is now `OutputRef`.
- `OutputValueStringError` is now `OutputRefStringError`.
- `isOutputValue`, `containsOutputValue` and `resolveOutputValues` are now `isOutputRef`, `containsOutputRef` and `resolveOutputRefs`.
