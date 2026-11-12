---
"@notation/reconciler": patch
---

An update now keeps the computed outputs that are in state, such as a value that only the create returns. Before, an update recorded only the resource's key, its params and what the read returned, so it dropped such a value. A value that the read returns still replaces the one in state.
