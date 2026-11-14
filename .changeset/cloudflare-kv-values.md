---
"@notation/cloudflare": minor
---

`@notation/cloudflare/resources` exports the resource `cloudflare/kv/KVValue`, which sets the value of one key in a Workers KV namespace. It depends on a `KVNamespace`, as `dependencies: { namespace }`.

- `Key` is required, and is 1 to 512 bytes. A change to `Key` deletes the old key, then writes the new one, so for a moment neither key exists.
- `Value` is a string, and is stored as it is. To store JSON, pass `JSON.stringify(value)`. A change to `Value` writes the key again.
- Create overwrites a value that the key already has. Delete deletes the key.
- KV is eventually consistent. After a write, create and update read the key until it returns the written value, for up to about 60 seconds, and fail after that. A later deploy that reads an older value plans an update, which writes the value again.

The `kv` namespace also exports calls for code that manages keys itself: `putKVValue`, `getKVValue`, `deleteKVValue`, `putKVValues` and `deleteKVValues`. A string value is stored as it is, and any other value is stored as JSON. `getKVValue` returns the text, or the parsed JSON when its `type` is `"json"`, and `undefined` for a missing key. `putKVValue` and `putKVValues` take optional metadata, an expiration and an expiration TTL. The bulk calls send up to 10,000 keys in each request, and throw if Cloudflare reports keys that it didn't change. The calls read `CLOUDFLARE_API_TOKEN`, as the resources do. When Cloudflare rate limits a call, the call throws a `ResourceOperationPendingError` with `retryAfterMs`. The reconciler retries it inside a resource operation. Other code must retry it itself.
