---
"@notation/cloudflare": minor
"@notation/resource": minor
"@notation/reconciler": minor
"@notation/cli": patch
---

A Durable Object namespace is deleted only when it is unprotected in state. Plan and deploy fail, before deploy changes anything, for a change that would delete a protected namespace.

- `$durableObject({ id, class, protect })` takes `protect`, which defaults to `true`. Plan reads it from the state of the hosting Worker. To delete a namespace, deploy `protect: false` first. A later deploy can remove the declaration, remove the Worker, or change the Worker's `id` or `name`. Changing only `protect` doesn't upload the Worker.
- Plan fails when a Worker no longer hosts a protected namespace that it hosted. This covers a removed declaration, and a changed `id`, with or without a changed `class`. Before, deploy deleted the namespace.
- Plan fails when a namespace's class export moves to another Worker. A namespace can't move to another Worker. Export the class from the old host again. Before, deploy deleted the namespace on the old host.
- Plan fails when a Worker that hosts protected namespaces is removed or replaced, as when its `id` or `name` changes. Before, deploy deleted the Worker with its namespaces.
- The check that a namespace doesn't take another namespace's class runs at plan, not during the Worker's upload.
- A schema param can be `stateOnly`: saved in state and not compared. A change to it alone doesn't update the resource. Deploy writes it to the state record, and plan lists the resource as a noop with the param in `stateChanged`.
- `defineOperations` takes `rejectChange(previous, desired, { replace })`. It returns a message to fail plan and deploy with. Plan and deploy call it for each resource that has a state record, and for each orphan whose class is registered, with `desired` undefined. `replace` is true when deploy deletes the resource and creates it again, also when a replaced dependency's delete needs it deleted first. `notation destroy` doesn't call it.
- Deploy now fails with a param's `rejectReplace` message before it changes any resource, when the param's value is known before deploy. Before, deploy failed just before the resource's operation.
