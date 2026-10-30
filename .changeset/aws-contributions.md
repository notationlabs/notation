---
"@notation/aws.iac": minor
"@notation/aws": minor
---

A Lambda's `Environment` is collected: contributions merge key by key, and `Environment.Runtime` holds structured runtime values that are encoded as one `NOTATION_RUNTIME` variable only when the function is created or updated. `@notation/aws.iac` adds `lambda.LambdaRolePolicy`, an inline role policy whose statements are collected, `lambda.LambdaEventSourceMapping`, and `sqs.Queue`. `@notation/aws/sqs` adds `queue({ name })`, with `arn` and `url` output values, `grant(actions)` and `consume(handler)`. `consume` gives the function's role access to the queue, adds a dispatch entry to the function's runtime values, and maps the queue to the function. A `LambdaGroup` exposes its `role`, and adds its inline `policy` the first time the policy is read.
