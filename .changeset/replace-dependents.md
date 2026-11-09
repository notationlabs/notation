---
"@notation/resource": minor
"@notation/reconciler": minor
"@notation/core": minor
"@notation/cli": minor
---

A resource type can list the classes it blocks the delete of, with `blocksDeleteOf` in `resource({ type, ... })`. For example, AWS does not delete an EventBridge bus that has rules, so an EventBridge rule type can list the event bus class:

```ts
const eventBridgeRule = resource<EventBridgeRuleSchema>({
  type: "aws/eventBridge/rule",
  blocksDeleteOf: [EventBus],
});
```

When deploy replaces a resource, it first deletes each dependent whose type lists the resource's class, and each dependent that blocks the delete of one of those in turn. It deletes them in reverse dependency order. Then it deletes the resource and creates it again, and creates the deleted dependents again with the new resource's outputs. Every other dependent stays in place, and deploy updates it when its params change, as before.

- `blocksDeleteOf` takes resource classes, or a function that returns them, for a class that cannot be imported without an import cycle. Classes are compared by their `type`. The resource class and each instance expose the list as `blocksDeleteOf`.
- The dependents are found by the edges in state. An orphan is checked with the registered class of the type in its record, and is deleted before the replaced resource too. When an orphan dependent's type has no registered class and a known class lists the type of the resource it depends on, plan and deploy fail before deploy deletes anything. The known classes are the registered classes and the classes of the resources in code. The error says to declare a resource of the orphan's type again, or to deploy the replacement before removing the last resource of that type. When no known class lists that type, the replacement goes ahead and the sweep warns about the orphan, as before.
- A dependent of several replaced resources is deleted and created once. If the deploy stops part way, the next deploy creates each dependent that has no record.
- A dry run decides `create` for each dependent it would delete, as deploy does.
- The plan shows each deleted dependent as `replace`. `replacedDependencies` lists its replaced dependencies that it blocks the delete of, and `deletedDependencies` lists the orphans of this kind. Each entry has `known: false` when the replacement depends on a field that is unknown at plan. `notation plan` prints `depends on <id>, which is replaced`, `which may be replaced`, `which is deleted` or `which may be deleted` under it.
- `createPlan` and `planApp` take a `registry`, as deploy does.
- The delete of a dependent emits lifecycle events with `reason: "dependency-replaced"` and `replacedDependency`.
