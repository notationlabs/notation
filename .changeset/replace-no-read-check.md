---
"@notation/reconciler": patch
---

Plan and deploy replace a resource whose type has no `read` and whose state record lacks a required output. Before, plan and the deploy check failed with `SchemaStructureError`, though the replace deletes the resource and creates it again, and the create writes the output. This also applies to a resource that deploy deletes before it replaces a dependency. Plan and deploy still fail when the deploy would leave the resource unchanged or update it.

When an immutable param of such a resource takes an output of a replaced dependency, plan can't know the output, so the replace is only possible. Plan passes in this case. Deploy replaces the resource if the output changes. If the output stays the same, deploy leaves the resource unchanged, and it fails when it reaches the resource.

Deploy now checks such a resource when it reaches it, not in the check before any change. When the decision is update, deploy fails before it calls the resource's `update`.
