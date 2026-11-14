---
"@notation/core": minor
"@notation/cli": minor
"@notation/cloudflare": minor
---

A secret can take its value from a resource that gets the value only once, in the response to its create. Notation writes the value to the secret in that create, and never records it.

- `@notation/core` exports `ProducedSource` and `SecretSource`, which is `Source | ProducedSource`. A resource group may expose a produced source in its `sources`, under a name such as `privateKey`. `accountToken()` keeps its own internal. Resource packages make one with `producedSource()`, which adds the target of the secret that takes the source to a collected param of the resource. Its optional `rotation` text says how to rotate the producer. The resource's create writes the value to the target with `writeSecretValue`. A store implementation is registered with `registerSecretStore`. One secret takes a produced source: collection fails when no secret takes it, and when a second secret takes it.
- `secret({ id, source })` from `@notation/cloudflare/secrets-store` takes a produced source. It doesn't take `key` with one. The secret depends on the resource that produces the value, and its create checks that the secret exists. If it is missing, the create fails and says how to rotate the producer. Destroy deletes the secret. `notation secret set` and `notation secret delete` refuse the secret, and say how to rotate the producer.
- A change to the target of the secret that takes a produced source, such as a new secret name, replaces the resource that produces it, as only a create gets a value. Plan labels the replacement or recreate of a producer as a rotation, and names the secret that gets a new value.
- To rotate an `accountToken()`, delete the API token in the Cloudflare dashboard and run `notation deploy`. The new token's create writes its value to the token's secret.
- `accountToken()` from `@notation/cloudflare/tokens` now declares the token and a `secret()` that takes its value, with the id of the token. `secretsStore.bind(token)` binds that secret.
- `cloudflare/tokens/AccountToken` has the param `ValueTarget`, the secret that its create writes the value to. When the write fails, the create deletes the new token. It no longer has `StoreId` or the output `SecretId`. Its read no longer checks the secret, and its delete no longer deletes the secret. This version does not upgrade state from earlier versions: destroy a stack that has an `accountToken()` with the earlier version before you deploy it with this one.
