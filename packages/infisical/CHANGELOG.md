# @notation/infisical

## 0.24.0

### Minor Changes

- cfd0daf: The old secret sources are removed. Declare a source from `@notation/std/resources` (`sources.Env`, `sources.Dotenv`) or `@notation/infisical/resources` (`InfisicalSecret`) in their place, and pass `source.credentials.value` to the resource that takes the value.

  - `@notation/std`: the `@notation/std/sources` entry point, with `env`, `dotenv` and `getValue`, and the `sources.SourceValue` resource are removed.
  - `@notation/infisical`: the `@notation/infisical/sources` entry point, with `infisical()`, is removed.
  - `@notation/core`: `Source`, `SourceContext`, `declareSecret`, the secret context (`runWithSecretContext`, `secretContext`), `PROMPT_SOURCE`, `SecretPrompt`, `setSecret`, `deleteSecret` and the `promptSecret` option of `deployApp` are removed. `Redacted` and scrubbing stay.
  - `@notation/resource`: `scopedPhysicalName` is removed.
  - CLI: `notation secret set`, `notation secret delete` and `--prompt-secrets` are removed. Deploy no longer asks for a secret's value on the terminal, and `watch` gives its deploys no stdin.
  - `--replace` refuses only a credential source as a source. A resource with no primary key is no longer treated as one.

- cfd0daf: `@notation/std/resources` exports the sources `sources.Env`, which takes `key`, and `sources.Dotenv`, which takes `path` and `key`. `@notation/infisical/resources` exports `InfisicalSecret`, which takes `projectId`, `environment`, `path` and `key`. Each has one credential, `value`, which another resource takes through `source.credentials.value`.

  - The revision of `Env` and `Dotenv` is the deploy's execution ID, so every resource that takes the value is written on every deploy.
  - The revision of `InfisicalSecret` is `version:<id>:<version>`, and `loadCredential` reads that version. A secret that refers to another secret has `exec:<execution ID>` as its revision. `loadCredential` fails for a revision in another format. The source also reads a secret imported into the folder; Infisical returns only the current version of an imported secret, so `loadCredential` fails when it was edited after deploy read it. Plan reads each secret with and without its references expanded to find out which case applies. `loadCredential` fails with `SecretReplacedError` when the secret was deleted and added again after deploy read it.
  - `track: "scrypt"` or `track: "hmac"` makes the revision a hash of the value, salted with the app, the stage and the source's ID. `"hmac"` needs a key in `NOTATION_TRACK_KEY`. `"scrypt"` is for generated values only. With `track`, a source whose value is not set keeps the revision in state and warns, and fails when state has no revision. With `track: "hmac"`, plan and deploy fail without `NOTATION_TRACK_KEY`, whether or not the value is set. `loadCredential` fails when the value's hash is not the revision.
  - `loadCredential` fails for an empty value.

### Patch Changes

- Updated dependencies [cfd0daf]
- Updated dependencies [386a2a9]
- Updated dependencies [8e240be]
- Updated dependencies [cfd0daf]
- Updated dependencies [386a2a9]
- Updated dependencies [cfd0daf]
  - @notation/resource@0.24.0
  - @notation/utils@0.24.0
  - @notation/std@0.24.0

## 0.23.0

### Patch Changes

- Updated dependencies [d1b66f5]
  - @notation/core@0.23.0

## 0.22.0

### Patch Changes

- Updated dependencies [524adee]
  - @notation/core@0.22.0

## 0.21.0

### Patch Changes

- @notation/core@0.21.0

## 0.20.0

### Minor Changes

- a9e3fe4: New package, part 3 of RFC 0017. `infisical({ projectId, environment, path })` from `@notation/infisical/sources` gives secrets their values from one folder of an Infisical project.

  - `environment` is an environment slug, or a function of the stage that returns one. `path` defaults to `/`. `siteUrl` defaults to `INFISICAL_DOMAIN`, and then to `https://app.infisical.com`.
  - The source lists the folder once in each plan or deploy, through `GET /api/v4/secrets`, and answers every key from that response. Secret references are expanded. Imported secrets, subfolders and personal overrides aren't read.
  - A key's version is the secret's ID and its Infisical version, so a secret is written to its store when it changes in Infisical. A secret whose value references another secret has no version, because its Infisical version doesn't change when the referenced secret changes. It is written on every deploy, like a secret from `env` or `dotenv`.
  - It logs in with `INFISICAL_TOKEN`, or with `INFISICAL_UNIVERSAL_AUTH_CLIENT_ID` and `INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET` through universal auth, or with `INFISICAL_IDENTITY_ID` through OIDC auth. The OIDC token is `INFISICAL_JWT`, or a token requested from GitHub Actions. `INFISICAL_OIDC_AUDIENCE` sets the audience of GitHub's token.

### Patch Changes

- Updated dependencies [a9e3fe4]
  - @notation/core@0.20.0
