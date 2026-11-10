---
"@notation/resource": minor
"@notation/reconciler": minor
"@notation/core": minor
"@notation/cli": minor
---

A resource type can list the types it blocks the delete of, with `blocksDeleteOf` in `resource({ type, ... })`. For example, AWS does not delete an EventBridge bus that has rules, so an EventBridge rule type can list the event bus type:

```ts
const eventBridgeRule = resource<EventBridgeRuleSchema>({
  type: "aws/eventBridge/rule",
  blocksDeleteOf: [EventBus.type],
});
```

When deploy replaces a resource, it first deletes each dependent whose type lists the resource's type, and each dependent that blocks the delete of one of those in turn. It deletes them in reverse dependency order. Then it deletes the resource and creates it again, and creates the deleted dependents again with the new resource's outputs. Every other dependent stays in place, and deploy updates it when its params change, as before.

- `blocksDeleteOf` takes resource types. The resource class exposes the list as `blocksDeleteOf`.
- The dependents are found by the edges in state. An orphan is checked with the registered class of the type in its record, and is deleted before the replaced resource too. An orphan whose type has no registered class is treated as not blocking the delete.
- A dependent of several replaced resources is deleted and created once. If the deploy stops part way, the next deploy creates each dependent that has no record.
- The plan shows each deleted dependent as `replace`, with `replacedDependency` set to the ID of the replaced resource. `notation plan` prints `deleted before <id> is replaced` under it.
- `createPlan` and `planApp` take a `registry`, as deploy does.
- The delete of a dependent emits lifecycle events with `reason: "dependency-replaced"` and `replacedDependency`.
