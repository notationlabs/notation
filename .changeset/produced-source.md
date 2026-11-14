---
"@notation/core": minor
"@notation/cli": minor
"@notation/cloudflare": minor
---

A secret can take its value from a resource that gets the value only once, in the response to its create. Notation writes the value to the secret in that create, and never records it.

- `@notation/core` exports `ProducedSource` and `SecretSource`, which is `Source | ProducedSource`. A resource exposes a produced source in its `sources`, such as `token.sources.value`. Resource packages make one with `producedSource()`, which adds the target of each secret that takes the source to a collected param of the resource. Its optional `rotation` text says how to rotate the producer. The resource's create writes the value to each target with `writeSecretValues`. When a write fails, it deletes the values that it wrote, and the error says that a secret may now be empty, which the next plan shows as drift. A store implementation is registered with `registerSecretStore`. Collection fails when no secret takes a produced source.
- `secret({ id, source })` from `@notation/cloudflare/secrets-store` takes a produced source. It doesn't take `key` with one. The secret depends on the resource that produces the value, and its create checks that the secret exists. If it is missing, the create fails and says how to rotate the producer. Destroy deletes the secret. `notation secret set` and `notation secret delete` refuse the secret, and say how to rotate the producer.
- A secret that starts or stops taking a produced source replaces the resource that produces it, as only a create gets a value. Plan labels the replacement or recreate of a producer as a rotation, and lists the secrets that get a new value.
- To rotate an `accountToken()`, delete the API token in the Cloudflare dashboard and run `notation deploy`. The new token's create writes its value to each secret that takes it.
- `accountToken()` from `@notation/cloudflare/tokens` now declares the token and a `secret()` that takes its value, with the id of the token. The token's `sources.value` can be given to other secrets too. `secretsStore.bind(token)` binds that secret.
- `cloudflare/tokens/AccountToken` has the param `ValueTargets`, the secrets that its create writes the value to, and no longer has `StoreId` or the output `SecretId`. Its read no longer checks the secret, and its delete no longer deletes the secret. This version does not upgrade state from earlier versions: destroy a stack that has an `accountToken()` with the earlier version before you deploy it with this one.
