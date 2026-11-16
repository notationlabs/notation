---
"@notation/resource": minor
"@notation/reconciler": minor
"@notation/cloudflare": patch
---

A resource class can set `readLagsCreate` in its meta when the provider can report a new resource as not found for a while after `create` returns. Deploy then reads the resource again after a create while the read throws `ResourceNotFoundError`, every 2 seconds, up to the operation attempt limit. Without the flag, that read still fails the create.

`cloudflare.workers.WorkerScript` and `cloudflare.workers.WorkerSubdomain` set the flag, so a deploy no longer fails when Cloudflare reports a Worker or its workers.dev subdomain as not found straight after creating it. `WorkerScript`'s create no longer waits until it can read the new Worker, and its wait for the list of secrets treats a not-found list as listing no secrets.
