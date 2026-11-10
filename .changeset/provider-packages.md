---
"@notation/resource": minor
"@notation/state": minor
"@notation/reconciler": minor
"@notation/core": minor
"@notation/aws.iac": minor
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

- A provider package exports its classes as `resourceClasses`. `resourceClassesIn(...namespaces)` from `@notation/resource` collects them from the package's module namespaces. The package adds a `default` condition to its `exports`, so that it can be resolved with `require` conditions. `@notation/aws.iac` and `@notation/std.iac` do both.
- `planApp`, `deployApp` and `destroyApp` in `@notation/core` load the provider packages of the state records whose type has no class in code. A package that can't be resolved or that throws on import is skipped with a `reconciler.provider.load-failed` warning, and its records stay in state.
- Before, an orphan whose type was no longer in code was left in place. Deploy now deletes it through the class of its provider package. This removes the limit on renaming an EventBridge bus in the deploy that removes its last rule.
- A resource whose ID is that of a state record of another type fails plan, deploy and destroy with `ResourceTypeChangedError`, before any change. A provider that changes a resource's type must give it a new ID.
- State written by an earlier version is not supported, as its records have no `provider`. Destroy the stack with the earlier version before you upgrade.
