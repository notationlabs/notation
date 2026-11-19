---
"@notation/cloudflare": minor
---

`$worker` and `worker()` take `observability`, to turn on Workers Logs with an optional `headSamplingRate`, `logpush`, to send trace events to the account's Logpush jobs, and `tailConsumers`, a function that returns the Workers that receive the Worker's tail events. `WorkerScript` takes the matching params `Observability`, `Logpush` and `TailConsumers`, sends them in the upload, and reads back each one that the params set, so a change made outside notation shows as drift. Each upload sends all three settings, and turns off an option that config leaves out. Each Worker has a `scriptName` output, the name that deploy gives the Worker in Cloudflare, which `wrangler tail` takes.
