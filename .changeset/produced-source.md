---
"@notation/core": minor
"@notation/resource": minor
"@notation/reconciler": minor
"@notation/cli": minor
"@notation/cloudflare": minor
---

A secret can take its value from a resource that gets the value only once, in the response to its create. Notation writes the value to the secret in that create, and never records it.

- `@notation/core` exports `ProducedSource` and `SecretSource`, which is `Source | ProducedSource`. A resource exposes a produced source in its `sources`, such as `token.sources.value`. Resource packages make one with `producedSource()`, which adds the target of each secret that takes the source to a collected param of the resource. Its optional `rotation` text says how to rotate the producer. The resource's create writes the value to each target with `writeSecretValues`. When a write fails, it deletes the values that it wrote, and the error says that a secret may now be empty, which the next plan shows as drift. A store implementation is registered with `registerSecretStore`. Collection fails when no secret takes a produced source.
- `secret({ id, source })` from `@notation/cloudflare/secrets-store` takes a produced source. It doesn't take `key` with one. The secret depends on the resource that produces the value, and its create checks that the secret exists. If it is missing, the create fails and says how to rotate the producer. Destroy deletes the secret. `notation secret set` and `notation secret delete` refuse the secret, and say how to rotate the producer.
- A secret that starts to take a produced source replaces the resource that produces it, as only a create gets a value. Plan labels the replacement or recreate of a producer as a rotation, and lists the secrets that get a new value.
- To rotate an `accountToken()`, delete the API token in the Cloudflare dashboard and run `notation deploy`. The new token's create writes its value to each secret that takes it.
- `accountToken()` from `@notation/cloudflare/tokens` now declares the token and a `secret()` that takes its value, with the id and name of the token. The token's `sources.value` can be given to other secrets too. `secretsStore.bind(token)` binds that secret.
- `cloudflare/tokens/AccountToken` has the param `ValueTargets`, the secrets that its create writes the value to, and no longer has `StoreId` or the output `SecretId`. Its read no longer checks the secret, and its delete no longer deletes the secret. A token that 0.20 deployed keeps its token and its value: the first deploy adds the record of its secret, `secret:<id>`, without writing the secret. After the upgrade, run one deploy before you run destroy or remove an `accountToken()`. A 0.20 state has no record of the secret, and the token's delete no longer deletes the secret, so destroy would leave the secret in the store.
- A schema param can have `backfill`, which gives its value for a state record that was written before the param was in the schema. Plan and deploy compare the desired value with it, so a param added to a schema doesn't replace the resources that exist. Use it only on a required param.
