---
"@notation/reconciler": minor
"@notation/core": patch
---

The durable runtime package is now `@notation/durable` 0.9.0. It replaces `yieldstar`, `@yieldstar/core` and `@yieldstar/sqlite-runtime`. An application that composes `deploy` or `destroy` in its own workflow must import from `@notation/durable` instead:

- `yieldstar` becomes `@notation/durable`.
- `@yieldstar/core` becomes `@notation/durable/runtime`.
- `@yieldstar/sqlite-runtime/node` becomes `@notation/durable/sqlite/node`.
