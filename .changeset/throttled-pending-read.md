---
"@notation/resource": minor
"@notation/reconciler": patch
---

`ResourceOperationPendingError` takes a `throttled` option. Set it to `true` when the provider refused the request because of a rate limit. A throttled `read` doesn't report that the resource exists: after a create with an unknown outcome, the reconciler looks the resource up again instead of recording the create as finished.
