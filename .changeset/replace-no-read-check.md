---
"@notation/reconciler": patch
---

Plan and deploy replace a resource whose type has no `read` and whose state record lacks a required output. Before, plan and the deploy check failed with `SchemaStructureError`, though the replace deletes the resource and creates it again, and the create writes the output. This also applies to a resource that deploy deletes before it replaces a dependency. Plan and deploy still fail when the deploy would leave the resource unchanged or update it.

The deploy check now decides each resource's action, without drift detection. A replace that the resource's type rejects now fails the deploy before any change, instead of when deploy reaches the resource.
