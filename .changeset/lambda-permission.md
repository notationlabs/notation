---
"@notation/aws": minor
---

`@notation/aws/resources` adds `lambda.LambdaPermission`, a statement in a function's resource policy that lets a service invoke the function. It replaces `lambda.LambdaApiGatewayV2Permission` and `eventBridge.LambdaEventBridgeRulePermission`, which are removed with their `Schema`, `Dependencies` and `Instance` types.

- `LambdaPermission` takes `Action`, `Principal` (a service, such as `events.amazonaws.com`) and an optional `SourceArn`, and depends on the function.
- Its `StatementId` comes from its resource ID. An ID that has characters other than letters, digits, `-` and `_`, or that is longer than 100 characters, ends in a hash of the full ID.
- `read` finds the statement with `GetPolicy`, so deploy detects a statement removed outside Notation.
- The API Gateway API resource has a new output, `ExecuteApiSourceArn`.
- In `@notation/aws`, API routes, schedules and EventBridge rules use `LambdaPermission`.
- State written by an earlier version is not supported. Its permission records have the removed types under the IDs that `LambdaPermission` now uses. Destroy the stack with the earlier version before you upgrade.
