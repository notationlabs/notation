---
"@notation/aws.iac": minor
"@notation/cli": minor
"@notation/core": minor
"@notation/reconciler": minor
"@notation/resource": minor
"@notation/std.iac": minor
---

A resource `read` now returns the remote object or throws the tagged `ResourceNotFoundError`. Operations that have started but not settled throw `ResourceOperationPendingError` with their retry delay and optional callback context. The reconciler follows those explicit instructions instead of guessing retry behaviour from provider errors or call-site context.
