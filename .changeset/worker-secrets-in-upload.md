---
"@notation/cloudflare": minor
"@notation/resource": minor
"@notation/reconciler": minor
"@notation/cli": patch
---

`$worker` sends a Worker's secrets in the upload of its code. `cloudflare.workers.WorkerScript` has a `Secrets` param, which maps each binding name to where its value comes from. Deploy reads each value and sends it as a `secret_text` binding. Every upload of a Worker reads every secret that has a source, so each source must be available on any deploy that changes the Worker. A secret without a source is sent only when the Worker doesn't have it. A secret that the Worker stops binding is deleted after the upload. A Worker's name is always generated.

`cloudflare.workers.WorkerSecret` and `cloudflare.workers.WorkerScriptPlaceholder` are removed. A deployment that has these resources in its state is not migrated.

Without a terminal, the first deploy of a new Worker with a secret that has no source now fails before it creates the Worker. Before, it left a placeholder Worker that `notation secret set` could write to.

Deploy fails, before it uploads, when a Worker is in a gradual rollout, as an upload ends the rollout.

`PhysicalNameRule` no longer has `suppliable`.
