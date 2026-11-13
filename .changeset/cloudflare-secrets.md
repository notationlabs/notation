---
"@notation/cloudflare": minor
---

Secrets for Workers, part 1 of RFC 0017. Notation records where a secret is, and never its value.

- `secret({ id, name })` from `@notation/cloudflare/secrets-store` declares a secret in the account's Secrets Store. Its name is `<app>--<stage>--<id>`, or `name` when it is set. Deploy writes its value from a source or a prompt; see the entry for part 2. Destroy deletes a secret with a stage-scoped name, and leaves a secret with an explicit `name`.
- `accountToken({ id, policies })` from `@notation/cloudflare/tokens` declares an account-owned API token. Each policy names its permission groups as Cloudflare lists them, such as `Workers Scripts Write`. When the token is created, its value is written to a secret with the token's name, `<app>--<stage>--<id>`, in the same step. A change to the policies updates the token, which keeps its value. If the secret is deleted, plan fails and says to rotate the token by changing its `id`. Destroy deletes the token and its secret. `CLOUDFLARE_API_TOKEN` needs the Account API Tokens: Edit permission.
- `secretsStore.bind(secret)` from `@notation/cloudflare/workers` binds a secret or a token to a Worker as a `secrets_store_secret` binding. In the Worker, `env.NAME` is a `SecretsStoreSecret`, read with `await env.NAME.get()`. The Worker is uploaded after the secret.
- Notation adds the account's Secrets Store as the resource `secrets-store`. It adopts the store if the account has one, and otherwise creates one named `default_secrets_store`. Destroy leaves the store. `CLOUDFLARE_API_TOKEN` needs the Secrets Store: Edit permission.
- `@notation/cloudflare/resources` exports the resources `cloudflare/secrets-store/SecretsStore`, `cloudflare/secrets-store/SecretsStoreSecret` and `cloudflare/tokens/AccountToken`.
