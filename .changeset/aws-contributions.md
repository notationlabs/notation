---
"@notation/aws.iac": minor
"@notation/aws": minor
---

SQS queues:

- `queue({ name })` from `@notation/aws/sqs` creates a queue, with `arn` and `url` output values.
- `queue.consume(handler)` invokes a function with the queue's messages. It grants the function's role read access, adds a dispatch entry to the function's runtime values, and creates an event source mapping.
- `queue.grant(actions)` returns a policy statement for the queue.

Lambda:

- A Lambda group's `policy` is an inline role policy that other code adds statements to. The group creates it the first time code reads `policy`.
- A Lambda group exposes its `role`.
- `Environment` is collected and merged key by key. `Environment.Runtime` holds structured runtime values, and the provider writes them to one `NOTATION_RUNTIME` variable.

`@notation/aws.iac` adds `lambda.LambdaRolePolicy`, `lambda.LambdaEventSourceMapping` and `sqs.Queue`.
