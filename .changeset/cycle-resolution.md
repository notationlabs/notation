---
"@notation/resource": minor
"@notation/reconciler": minor
"@notation/cli": minor
"@notation/cloudflare": minor
---

Deploy resources that depend on each other through contributions, as RFC 0011 describes. Before, plan and deploy failed on any dependency cycle.

- In each loop, deploy picks a placeholder: a member that depends on the others only through its contributions, whose params that those contributions set are optional and don't force a replacement, and whose type has `update`. Deploy creates it without the contributions that refer to the other members, creates the other members, and then updates it with its full params. With drift detection, a placeholder that no longer exists is created again in the first pass. A dry run stops after the first pass.
- Deploy then applies every member again until no output changes, for at most one pass per member. If an output still changes, deploy fails with `ResourceCycleError`, naming the outputs that changed. When no member of a loop can be the placeholder, plan and deploy fail with `ResourceCycleError`, which says why for each member.
- Destroy reverts each placeholder to its placeholder params before it deletes the cycle. Before deploy replaces a member, it reverts the members, and the resources outside the cycle, that refer to it through contributions, and later updates them again. A revert starts from the params in the record, so it changes only the params that the left-out contributions set, and the hidden params. The reverts emit update events with `reason: "cycle-revert"`.
- The removal of the record of a dependent that blocks the delete of a replaced resource has the state write key `state:delete:<id>:replace:<replaced id>`, so that two replacements in one deploy can each delete the same dependent.
- Plan nodes have `cycle`, `placeholder` and `revertedPeers`, and `notation plan` prints a line for a placeholder and for a replacement that reverts other members.
- Resources have `getFixedDependencies()` and `getContributedParams({ from })`, and `getParams({ excludeContributionsFrom })` returns the params without the contributions that depend on the given resources. Exports `changedKeys` and `forcesReplacement` from `@notation/resource`.
- `@notation/cloudflare`: a Worker's service binding to another Worker is a contribution to its script's `Bindings`, which is now a collected param. Two Workers can bind each other as services. Workers that each bind a namespace that the other hosts still fail plan. The service bindings now come after the bindings in config, so a Worker whose service bindings came before other bindings is updated once on the next deploy.
