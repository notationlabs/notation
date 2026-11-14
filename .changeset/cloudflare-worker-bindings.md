---
"@notation/cloudflare": minor
---

A Worker can bind an R2 bucket, a KV namespace, a JSON value and a secret.

- `$worker` bindings take an `R2Bucket` resource, a `KVNamespace` resource, a value from `json(value)` and a secret from `workerSecret()`. In `env`, these are an `R2Bucket`, a `KVNamespace`, the JSON value and a `string`. A Worker that binds a bucket or a namespace is uploaded after it.
- `workerSecret({ id, source?, key? })` from `@notation/cloudflare/workers` declares a secret that a Worker binds as secret text. The value comes from the source, or from the prompt when there is no source. `notation secret set` and `notation secret delete` take a Worker secret once the Workers that bind it are deployed. State records the source, the key and the source's version, and never the value.
- The new `WorkerSecret` resource sets one secret of a Worker with Cloudflare's secrets API for the Worker. A Worker gets one for each Worker secret that it binds. It writes a sourced value when the source's version changes, and a value without a source only when the Worker doesn't have it. It deletes the secret when the Worker stops binding it.
- `WorkerScript` takes `r2_bucket` and `json` bindings. Each upload keeps the Worker's `secret_text` bindings, so an upload never needs a secret's value. This also keeps a secret set with `wrangler secret put`, which an upload deleted before.
