---
"@notation/cloudflare": minor
---

`@notation/cloudflare/resources` exports the resource `cloudflare/kv/KVNamespace`, which makes a Workers KV namespace. `WorkerScript` takes a `kv_namespace` binding, which binds a namespace by its ID. Both are at the resource level only: `$worker` can't bind a namespace yet.

- `Title` is required, and must be unique in the account. A change to `Title` renames the namespace. Create fails when the account already has a namespace with the title.
- `Jurisdiction` is optional, and is one of `eu`, `fedramp` or `us`. Cloudflare sets it only when it creates the namespace, so plan fails when it changes.
- The API token also needs the Workers KV Storage: Edit permission.
