---
"@notation/cloudflare": minor
"@notation/resource": minor
"@notation/reconciler": minor
---

A Durable Object namespace is deleted only when it is unprotected in state. Plan and deploy fail, before deploy changes anything, for a change that would delete a protected namespace.

- `$durableObject({ id, class, protect })` takes `protect`, which defaults to `true`. Plan reads it from the state of the hosting Worker. To delete a namespace, deploy `protect: false` first, which updates the Worker. A later deploy can remove the declaration, remove the Worker, or change the Worker's `id` or `name`.
- Plan fails when a Worker no longer hosts a protected namespace that it hosted. This covers a removed declaration, and a changed `id`, with or without a changed `class`. Before, deploy deleted the namespace.
- Deploy moves a namespace, with its objects, when its class export moves to another Worker and the old host still binds the namespace. The new host's upload moves it, using Cloudflare's `expecting-transfer` and `transferred` exports entries. Plan fails when the old host no longer binds a protected namespace whose class moved, when the move also changes the class, and when the new host gets a namespace that another Worker binds in the deploy that renames or deletes another of its namespaces. Deploy fails before any upload when the new host is created in the same deploy, which plan doesn't catch, and when the old host hosts a namespace that Cloudflare doesn't list as SQLite. Before, deploy deleted the namespace on the old host, and the new host got a new, empty namespace.
- Plan fails when a Worker that hosts protected namespaces is removed or replaced, as when its `id` or `name` changes. Before, deploy deleted the Worker with its namespaces.
- The check that a namespace doesn't take another namespace's class runs at plan, not during the Worker's upload.
- `defineOperations` takes `rejectChange(previous, desired, { replace })`. It returns a message to fail plan and deploy with. The resource class and its instances expose it. Plan and deploy call it for each resource that has a state record, and for each orphan that the orphan sweep deletes, with `desired` undefined. `replace` is true when deploy deletes the resource and creates it again, also when a replaced dependency's delete needs it deleted first. `notation destroy` doesn't call it.
- Deploy now fails with a param's `rejectReplace` message before it changes any resource, when the param's value is known before deploy. Before, deploy failed just before the resource's operation.
