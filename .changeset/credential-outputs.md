---
"@notation/resource": minor
"@notation/reconciler": minor
"@notation/cloudflare": minor
"@notation/cli": patch
---

A resource schema can declare a `credential` property, for a secret that the provider returns only from `create`, such as the value of an API token. Another resource takes it with `resource.credentials.<name>`, and its operations receive the value in their params. Deploy keeps the value in memory only: state, step results and events hold a marker in its place. When a resource that takes a credential needs its value and deploy no longer holds it, deploy calls the credential's `rotate` operation, or replaces the resource when it has none, and then updates every resource that takes the credential.

`cloudflare.tokens.AccountToken` returns its value as the credential `Value`, and no longer writes a secret itself. It has no `StoreId` param, no `SecretId` output and no `store` dependency. `cloudflare.secretsStore.SecretsStoreSecret` takes either `ValueFrom` or the new param `Value`. `accountToken()` declares the token and a secret `secret:<id>` that takes its value.

A stack that has an `accountToken()` gets a new token value on its first deploy with this version: deploy creates the secret resource, rolls the token, and writes the new value over the secret. The token keeps its ID.
