---
"@notation/resource": minor
"@notation/reconciler": minor
---

A `physicalName` rule can have `suppliable: true`, so that the params can supply the name.

- With `suppliable`, the param is optional in config, and config, a contribution or `deriveParams` can supply it. Without it, the params still can't supply the name.
- The name in the state record wins over a supplied name, and a supplied name wins over a generated one. So a supplied name names the resource when deploy first creates it, and never renames a resource that exists. A replacement takes the supplied name, or a generated one when the params supply none.
- Plan shows the supplied name for a resource with no record. It shows the recorded name for a resource with a record, even when the supplied name is unknown at plan, so an unknown supplied name does not show as a replace.
