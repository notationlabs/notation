---
"@notation/aws.iac": minor
"@notation/cli": minor
"@notation/core": minor
"@notation/reconciler": minor
"@notation/resource": minor
"@notation/std.iac": minor
---

A resource `read` now returns the remote object, or `undefined` when it does not exist. Providers translate their own not-found exceptions at the boundary. Known temporary conditions — a Lambda that is still deploying, an IAM role that has not propagated — throw the tagged `ResourceNotReadyError`, which the reconciler retries during deploys and reports as an `indeterminate` plan decision.
