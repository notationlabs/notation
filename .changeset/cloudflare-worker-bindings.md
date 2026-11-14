---
"@notation/cloudflare": minor
---

A Worker can bind an R2 bucket, a KV namespace, a JSON value and a secret.

- `$worker` bindings take an `R2Bucket` resource, a `KVNamespace` resource, a value from `json(value)` and a secret from `workerSecret()`. In `env`, these are an `R2Bucket`, a `KVNamespace`, the JSON value and a `string`. A Worker that binds a bucket or a namespace is uploaded after it.
- `workerSecret({ id, source?, key? })` from `@notation/cloudflare/workers` declares a secret that a Worker binds as secret text. The value comes from the source, or from the prompt when there is no source. `notation secret set` writes a Worker secret to each deployed Worker that binds it, and fails when none is deployed. `notation secret delete` deletes it from each of them. State records the source, the key and the source's version, and never the value.
- The new `WorkerSecret` resource sets one secret of a Worker with Cloudflare's secrets API for the Worker. A Worker gets one for each Worker secret that it binds. It writes a sourced value when the source's version changes, and a value without a source only when the Worker doesn't have it. It deletes the secret when the Worker stops binding it.
- The new `WorkerScriptPlaceholder` resource makes sure a Worker exists before its secrets are set. A Worker that binds a Worker secret is created as a placeholder that answers 503 and has the tag `notation-placeholder`, then its secrets are set, then its code is uploaded, which removes the tag. So new code never runs without its secrets. The placeholder refuses a Worker that exists without the tag. A live Worker that gains its first secret keeps its name, and gets no placeholder upload.
- `WorkerScript` takes `ScriptName` in config, for a Worker created with the name of its placeholder. The name in its state record wins. Its create uploads over a Worker with the placeholder tag.
- `WorkerScript` takes `r2_bucket` and `json` bindings. Each upload keeps the Worker's `secret_text` bindings, so an upload never needs a secret's value. This also keeps a secret set with `wrangler secret put`, which an upload deleted before.
