---
"@notation/cloudflare": minor
---

A Worker can bind an R2 bucket, a KV namespace, a JSON value and a secret.

- `$worker` bindings take an `R2Bucket` resource, a `KVNamespace` resource, a value from `json(value)` and a secret from `workerSecret()`. In `env`, these are an `R2Bucket`, a `KVNamespace`, the JSON value and a `string`. A Worker that binds a bucket or a namespace is uploaded after it.
- `workerSecret({ id, source, key })` from `@notation/cloudflare/workers` declares a secret that a Worker binds as secret text. A source and a key are required. Deploy reads the value from the source each time it uploads the Worker. State records the source, the key and the source's version, and never the value. A new version from the source uploads the Worker again. For `env` and `dotenv`, that is every deploy.
- `WorkerScript` takes `r2_bucket` and `json` bindings in `Bindings`, and a new `SecretBindings` param. Each entry of `SecretBindings` has a binding name and a `ValueFrom`, as in `SecretsStoreSecret`. Create and update read each value with `getValue`, and upload it as a `secret_text` binding.
