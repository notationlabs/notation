---
"@notation/resource": minor
"@notation/reconciler": patch
---

A resource that is constructed while infra is evaluated is now part of the deployment when no group adds it, such as a top-level `new workers.WorkerScript(...)`. Before, deploy dropped it with no error, and plan showed nothing to create. The resource has `group: null`. When a group adds it later, `add()` sets its group. Adding a resource to two groups, or to one group twice, still throws. A resource constructed while no graph is being collected joins no graph, as before.

When a deployed resource moves into a group, out of one, or to another group, deploy now writes the new group to its record without calling `update`. Before, the record kept the old group until the resource next changed.
