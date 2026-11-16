---
"@notation/std": minor
"@notation/infisical": minor
---

`@notation/std/resources` exports the sources `sources.Env`, which takes `key`, and `sources.Dotenv`, which takes `path` and `key`. `@notation/infisical/resources` exports `InfisicalSecret`, which takes `projectId`, `environment`, `path` and `key`. Each has one credential, `value`, which another resource takes through `source.credentials.value`.

- The revision of `Env` and `Dotenv` is the deploy's execution ID, so every resource that takes the value is written on every deploy.
- The revision of `InfisicalSecret` is `version:<id>:<version>`, and `loadCredential` reads that version. A secret that refers to another secret has `exec:<execution ID>` as its revision. `loadCredential` fails for a revision in another format. The source also reads a secret imported into the folder; Infisical returns only the current version of an imported secret, so `loadCredential` fails when it was edited after deploy read it. Plan reads each secret with and without its references expanded to find out which case applies. `loadCredential` fails with `SecretReplacedError` when the secret was deleted and added again after deploy read it.
- `track: "scrypt"` or `track: "hmac"` makes the revision a hash of the value, salted with the app, the stage and the source's ID. `"hmac"` needs a key in `NOTATION_TRACK_KEY`. `"scrypt"` is for generated values only. With `track`, a source whose value is not set keeps the revision in state and warns, and fails when state has no revision. With `track: "hmac"`, plan and deploy fail without `NOTATION_TRACK_KEY`, whether or not the value is set. `loadCredential` fails when the value's hash is not the revision.
- `loadCredential` fails for an empty value.
