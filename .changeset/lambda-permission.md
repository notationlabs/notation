---
"@notation/resource": minor
"@notation/state": minor
"@notation/reconciler": minor
"@notation/core": minor
"@notation/aws.iac": minor
"@notation/aws": minor
"@notation/std.iac": minor
---

`resource()` now requires `provider`, the name of the package that exports the resource class. Each state record stores it, so that deploy and destroy can delete a record whose type is no longer in code.

```ts
const queue = resource<QueueSchema>({
  type: "aws/sqs/Queue",
  provider: "@notation/aws.iac",
});
```

This breaks every resource class outside this repository: a class without `provider` fails type checking.

- A provider package exports its classes, deprecated ones included, as `resourceClasses`. `resourceClassesIn(...namespaces)` from `@notation/resource` collects them from the package's module namespaces. The package adds a `default` condition to its `exports`, so that it can be resolved with `require` conditions.
- `planApp`, `deployApp` and `destroyApp` in `@notation/core` load the provider packages of the state records whose type has no class in code. A record written before this change names no provider, and is looked up in `@notation/aws.iac` and `@notation/std.iac`. A package that can't be resolved or that throws on import is skipped with a `reconciler.provider.load-failed` warning, and its records stay in state.
- Before, an orphan whose type was no longer in code was left in place. Deploy now deletes it through the class of its provider package.
- A resource whose ID is that of a state record of another type fails plan, deploy and destroy with `ResourceTypeChangedError`, before any change. A provider that changes a resource's type must give it a new ID.
- At plan, a required output that a dependency's state record lacks is unknown, not `undefined`. A record written before the output was added lacks it.
- `@notation/aws.iac` adds `lambda.LambdaPermission`, a statement in a function's resource policy that lets a service invoke the function. It takes `Action`, `Principal` (a service, such as `events.amazonaws.com`) and an optional `SourceArn`, and depends on the function. Its `StatementId` comes from its resource ID. An ID that has characters other than letters, digits, `-` and `_`, or that is longer than 100 characters, ends in a hash of the full ID. `read` finds the statement with `GetPolicy`, so deploy detects a statement removed outside Notation.
- `lambda.LambdaApiGatewayV2Permission` and `eventBridge.LambdaEventBridgeRulePermission` are deprecated. They can only delete the statements they created. The types `LambdaApiGatewayV2PermissionSchema`, `LambdaApiGatewayV2PermissionDependencies`, `LambdaApiGatewayV2PermissionInstance`, `LambdaEventBridgeRulePermissionSchema`, `LambdaEventBridgeRulePermissionDependencies` and `LambdaEventBridgeRulePermissionInstance` are removed.
- The API Gateway API resource has a new output, `ExecuteApiSourceArn`.
- In `@notation/aws`, API routes, schedules and EventBridge rules use `LambdaPermission`. On the first deploy after this change, each of their permissions is created again under a new ID, and then the old statement is deleted.
