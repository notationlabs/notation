---
"@notation/core": minor
"@notation/cloudflare": minor
---

`accountToken()` from `@notation/cloudflare/tokens` now declares the token and a secret that holds its value, as separate resources.

- The secret has the id of the token. `secretsStore.bind(token)` binds that secret. The secret depends on the token, and the token's create writes the value to it. The secret's create only checks that the secret exists.
- The token's read no longer checks the secret. A deleted secret shows in plan as drift, and deploy fails at the secret with what to do.
- The token's delete no longer deletes the secret, so a replaced token writes its value to the same secret. Destroy deletes the secret, then the token.
- To rotate a token, delete it in the Cloudflare dashboard and run `notation deploy`. The new token writes its value to the same secret.
- `cloudflare/tokens/AccountToken` has the param `ValueTarget`, `{ AccountId, StoreId, Name }`, the secret that its create writes the value to. A change to it replaces the token. It no longer has `StoreId` or the output `SecretId`.
- `@notation/core` exports `ONE_TIME_SOURCE`, the source name that such a secret records.
- This version does not upgrade state from earlier versions: destroy a stack that has an `accountToken()` with the earlier version before you deploy it with this one.
