---
"@notation/cloudflare": minor
---

`@notation/cloudflare/resources` exports the resource `cloudflare/kv/KVValue`, which sets the value of one key in a Workers KV namespace. It depends on a `KVNamespace`, as `dependencies: { namespace }`.

- `Key` is required, and is 1 to 512 bytes. A change to `Key` writes the new key, then deletes the old key at the end of the deploy. If the new key already exists, the deploy fails and the old key stays as it was.
- `Value` is a string, and is stored as it is. To store JSON, pass `JSON.stringify(value)`. A change to `Value` writes the key again.
- Create fails when the key already exists in the namespace, rather than overwrite it. KV is eventually consistent, so a key deleted in the last minute can still read as existing, and a key written elsewhere in the last minute may not be seen. Delete deletes the key.
- Create waits while the KV calls report that the namespace doesn't exist, for up to about 60 seconds. A namespace that the same deploy created can be missing from them for a few seconds.
- KV is eventually consistent. After a write, create and update read the key until it returns the written value, for up to about 60 seconds, and fail after that. A later deploy that reads an older value plans an update, which writes the value again.
