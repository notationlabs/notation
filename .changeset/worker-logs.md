---
"@notation/cloudflare": minor
---

`$worker` and `worker()` take `observability`, to turn on Workers Logs with an optional `headSamplingRate`, `logpush`, to send trace events to the account's Logpush jobs, and `tailConsumers`, a function that returns the Workers that receive the Worker's tail events. `WorkerScript` takes the matching params `Observability`, `Logpush` and `TailConsumers`, sends them in the upload, and reads them back from the Worker's settings, so a change made outside notation shows as drift. Deploy turns a setting off when its option is removed. Each Worker has a `scriptName` output, the name that deploy gives the Worker in Cloudflare, which `wrangler tail` takes.
