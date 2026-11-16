---
"@notation/cli": minor
"@notation/core": minor
"@notation/infisical": minor
"@notation/reconciler": patch
"@notation/resource": minor
"@notation/std": minor
---

The old secret sources are removed. Declare a source from `@notation/std/resources` (`sources.Env`, `sources.Dotenv`) or `@notation/infisical/resources` (`InfisicalSecret`) in their place, and pass `source.credentials.value` to the resource that takes the value.

- `@notation/std`: the `@notation/std/sources` entry point, with `env`, `dotenv` and `getValue`, and the `sources.SourceValue` resource are removed.
- `@notation/infisical`: the `@notation/infisical/sources` entry point, with `infisical()`, is removed.
- `@notation/core`: `Source`, `SourceContext`, `declareSecret`, the secret context (`runWithSecretContext`, `secretContext`), `PROMPT_SOURCE`, `SecretPrompt`, `setSecret`, `deleteSecret` and the `promptSecret` option of `deployApp` are removed. `Redacted` and scrubbing stay.
- `@notation/resource`: `scopedPhysicalName` is removed.
- CLI: `notation secret set`, `notation secret delete` and `--prompt-secrets` are removed. Deploy no longer asks for a secret's value on the terminal, and `watch` gives its deploys no stdin.
- `--replace` refuses only a credential source as a source. A resource with no primary key is no longer treated as one.
