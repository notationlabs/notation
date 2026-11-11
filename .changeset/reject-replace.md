---
"@notation/resource": minor
"@notation/reconciler": minor
---

A param's schema item can set `rejectReplace: (previous, desired) => string`. When a change to the param would replace the resource, plan and deploy fail with the returned message, instead of replacing the resource.
