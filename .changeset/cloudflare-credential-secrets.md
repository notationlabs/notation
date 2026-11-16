---
"@notation/cloudflare": minor
"@notation/reconciler": patch
---

`cloudflare.secretsStore.SecretsStoreSecret` takes its value from a credential only, in `Value`, which is required. `ValueFrom` and `StageScoped` are removed. Deploy names the secret `<app>--<stage>--<resource id>-<8 hex characters>`, cut to 255 characters, so config can't set `Name`. Delete always deletes the secret. `cloudflare.tokens.AccountToken` is named in the same way, cut to 120 characters.

Each entry of `cloudflare.workers.WorkerScript`'s `Secrets` is a credential, such as `source.credentials.value`. State holds a marker for each one. A create sends every secret. An update sends only the secrets whose credential has a new version, and Cloudflare keeps the others.

`$worker`'s `bindings` takes a credential, which it binds as a `secret_text` binding (a `string` in the handler), and a `SecretsStoreSecret`, which it binds as a `secrets_store_secret` binding (a `SecretsStoreSecret` in the handler). `$worker` fails for an output ref that is not a credential.

`secret()`, `accountToken()`, `workerSecret()`, `secretsStore.bind()`, `BindableSecret`, `SecretsStoreGroup` and the `@notation/cloudflare/secrets-store` and `@notation/cloudflare/tokens` entry points are removed. Declare a `SecretsStore`, an `AccountToken` and a `SecretsStoreSecret` from `@notation/cloudflare/resources` in their place.

A drift update compares credentials with the read of the remote, so it receives the value of a credential that the remote lost, such as a Worker secret deleted outside notation. A read can return the credential markers of the params that it received.
