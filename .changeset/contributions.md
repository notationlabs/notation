---
"@notation/resource": minor
"@notation/reconciler": minor
"@notation/core": minor
"@notation/utils": minor
---

Collected params: several pieces of code can add to one param.

- A schema item with `collect` makes its param collected. `collect` combines the config value and every contribution, sorted by content.
- `resource.contribute(values)` adds to a collected param while infra is evaluated. Contributions close when evaluation ends.
- `resource.contribute(({ deps }) => values, { deps })` adds values computed from the real outputs of `deps` at deploy. The resource depends on `deps`.
- `mergeContributions` merges maps key by key. Two contributions that set one key to different values throw `ContributionConflictError`, which names the `file:line` of both `contribute` calls.

Output values: config can hold a resource's output before the resource exists.

- `resource.outputValue(key)` returns a token. The holder depends on the resource, and deploy replaces the token with the real output.
- Turning a token into a string throws `OutputValueStringError`. Compute with outputs in `deriveParams` or a function contribution.

Plan:

- A value that waits on an undeployed output shows as unknown at its own path.
- `deriveParams` and function contributions receive views of their deps. Reading the output of an undeployed dep throws `PendingOutput`, and plan marks the affected params unknown.
- Plan and deploy fail when a resource depends on a resource that is not part of the deployment. Before, the graph ignored the edge.

Other:

- `resource.dependOn(other)` adds a dependency after construction.
- `onEvaluationEnd(callback)` runs a callback after evaluation, before contributions close.
- `@notation/utils` adds `sortedJson`, JSON with sorted keys.
