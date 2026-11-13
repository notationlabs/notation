# notation secret

```sh
notation secret set <id> [--config <path>] [--stage <stage>]
notation secret delete <id> [--config <path>] [--stage <stage>] [--yes]
```

| Option            | Meaning                                                     |
| ----------------- | ----------------------------------------------------------- |
| `--config <path>` | The config file. Default: the nearest `notation.config.ts`. |
| `--stage <stage>` | The stage. Default: `defaultStage`.                         |
| `--yes`           | `delete` only. Deletes without asking for confirmation.     |

`<id>` is the id of the secret's declaration, such as `admin-password` for `secret({ id: "admin-password" })`. See [Secrets](../manual/secrets.md).

## `set`

`set` writes a secret's value to its store. It reads the value from a hidden prompt on a terminal, and from stdin otherwise, with one trailing line break dropped. It never takes the value as an argument, so the value isn't kept in shell history or shown in `ps`.

```sh
notation secret set admin-password --stage prod
op read op://prod/admin/password | notation secret set admin-password --stage prod
```

`set` compiles the infra, and finds the secret's location from its params and from state. It writes the value with the secret's own create or update. It doesn't run the reconciler, and records nothing.

Run `set` before a deploy without a terminal, such as in CI, for each secret that has no source. If the secret has a source, the source wins at its next write: on the next deploy for `env` and `dotenv`, and when the version changes for a versioned source.

## `delete`

`delete` deletes a secret from its store, with the secret's own delete. It succeeds if the secret is already gone. It asks for confirmation on a terminal, and needs `--yes` without one.

## Errors

Both commands fail when:

- No secret has the id. The message lists the declared ids.
- The secret's location depends on a resource that hasn't been deployed:

  ```text
  `admin-password`'s location depends on `secrets-store`, which hasn't been deployed. Run `notation deploy`.
  ```

- The id is an API token's, whose value only the token's create can write.

`delete` also refuses a secret that a provider adopted rather than created, such as a Cloudflare secret with an explicit `name`.
