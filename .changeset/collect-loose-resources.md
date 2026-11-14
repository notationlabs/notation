---
"@notation/resource": minor
"@notation/reconciler": patch
---

A resource that is constructed while infra is evaluated is now part of the deployment when no group adds it, such as a top-level `new workers.WorkerScript(...)`. Before, deploy dropped it with no error, and plan showed nothing to create. The resource has `group: null`. When a group adds it later, `add()` sets its group. Adding a resource to two groups, or to one group twice, throws. Before, adding a resource to two groups threw only while a graph was being collected. The error now names the resource's type, its ID and the group it is in. A resource constructed while no graph is being collected joins no graph, as before.

When a deployed resource moves into a group, out of one, or to another group, deploy now writes the new group to its record without calling `update`. Before, the record kept the old group until the resource next changed.

Rolling back to an older CLI after a deploy with this version deletes resources. An older CLI does not collect a resource that no group adds. Its next deploy treats the resource as an orphan, because the resource has a record but is not in the graph, and deletes it.
