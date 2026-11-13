---
"@notation/core": minor
"@notation/std": minor
"@notation/reconciler": minor
"@notation/utils": minor
"@notation/cli": minor
"@notation/cloudflare": minor
---

Secrets take their values from sources, part 2 of RFC 0017. Notation writes a secret's value to its store, and never records the value.

- `secret({ id, source, key })` from `@notation/cloudflare/secrets-store` takes its value from a source. `@notation/std/sources` exports `env`, which reads `process.env`, and `dotenv(path)`, which reads a `.env` file relative to the project root. `source` and `key` are given together. Each secret with a source has a `SourceValue` resource, `value:<id>`, which records the source's name, the key and a version. `env` and `dotenv` have no versions, so their secrets are written on every deploy. Plan and deploy fail when the source doesn't have the key.
- A secret without a source takes its value from a hidden prompt, when deploy creates it. With no terminal, or with `--json`, deploy fails with the command that sets the secret. `notation watch` asks once for each secret. Plan never asks, and notes that deploy will. A secret without a source that already exists is recorded without asking.
- `notation secret set <id>` writes a secret's value, read from a hidden prompt or from stdin. `notation secret delete <id>` deletes a secret, and needs `--yes` without a terminal. Both refuse an API token's secret.
- `SecretsStoreSecret` now requires `ValueFrom`, and its create and update write the value.
- `Redacted` from `@notation/core` holds a secret value. Turning it into a string or JSON throws, and `console.log` prints `Redacted(<hidden>)`. A source implements the `Source` interface from `@notation/std/sources`, and a resource reads a value with `getValue(id)`.
- The CLI removes every secret value that it read from what it prints, and the reconciler removes them from the errors of operations before it records them.
