---
"@notation/cloudflare": minor
"@notation/aws": patch
"@notation/utils": minor
---

`kvJson()` in the new `@notation/cloudflare/kv` entry point declares a JSON document in a KV key, with a `schema` option. It returns a `KVJsonGroup` with `schema`, `value` and `contribute`. Any infra module can add object keys to the document with `contribute`, and the parts merge as a Lambda's `Environment` does. Plan and deploy check the merged document against the schema before they write it. Each contribution is typed as a `JsonPartial` of the schema's input.

`cloudflare.kv.KVJsonValue` in `@notation/cloudflare/resources` is the resource that `kvJson()` declares. Its `Value` param is a JSON value, written with sorted keys. Its validator refuses a value that `JSON.stringify` would change, such as `NaN`, a `Date`, a sparse array or a nested `undefined`, an object key named `__proto__`, and a text of more than 25 MiB. A read of text that is not JSON, or JSON that the validator refuses, returns the text as a string, so plan shows an update rather than failing. Text too long to hold as a JSON string within 25 MiB reads as a short string that gives its length.

`readKVJson(namespace, key, schema)` and `KVJsonError` in `@notation/cloudflare/workers` read a JSON document in a Worker. `readKVJson()` returns `undefined` for a missing key, and throws `KVJsonError` for text that is not JSON or a value that fails the schema.

The `JsonValue` type of the KV API calls is replaced by `Json`, which `json()` bindings use. A pending write check of a `KVValue` now names the class in its message.

`assertId`, `isNameSafe`, `ID_MAX_LENGTH`, `NameSafe` and `IdOption` move from `@notation/aws` to `@notation/utils`, and `@notation/aws` re-exports them. The error for a missing id no longer says that the id is the base of the AWS name.
