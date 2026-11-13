---
"@notation/resource": minor
"@notation/reconciler": minor
---

Add two kinds of ref that add no dependency, for resource packages.

- `resource["~state"].outputRef(key)` reads an output from the target's state record at the start of the deploy, and at plan. It resolves to nothing when the target has no record, and an array leaves the entry out. It reads only a param that is `immutable`, `primaryKey` or `secondaryKey`, or that has `physicalName`, or a computed `primaryKey`, and throws for any other output.
- A ref from a resource to its own `physicalName` param is filled in with the name before `create`, so the resource is created once and is not a cycle of one.
