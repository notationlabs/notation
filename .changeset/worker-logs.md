---
"@notation/cloudflare": minor
---

`$worker` and `worker()` take `observability`, to turn on Workers Logs with an optional `headSamplingRate`, `logpush`, to send trace events to the account's Logpush jobs, and `tailConsumers`, a function that returns the Workers that receive the Worker's tail events. `headSamplingRate` must be from 0 to 1, and set only with `enabled: true`. `WorkerScript` takes the matching params `Observability`, `Logpush` and `TailConsumers`, sends them in the upload, and reads back each one that the params set. Each upload sends all three settings, and turns off an option that the params leave out. A Worker declared with `$worker` or `worker()` sets all three params, so a setting changed in the dashboard shows as drift and deploy sets it back. The first deploy after the upgrade updates each Worker, to record the new params. Each Worker has a `scriptName` output, the name that deploy gives the Worker in Cloudflare, which `wrangler tail` takes.
