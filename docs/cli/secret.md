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

`set` compiles the infra, finds the secret's declaration, and writes the value to the store. It doesn't read state, run the reconciler, or record anything, so it works before the first deploy. For a Cloudflare secret, it creates the account's Secrets Store if the account has none. A [Worker secret](../providers/cloudflare/workers.md#workersecretconfig) is the exception. It is stored with each Worker that binds it, so `set` writes it to each of those Workers that is deployed, and fails when none is deployed. `delete` deletes it from each of those Workers.

Run `set` before a deploy without a terminal, such as in CI, for each secret that has no source. A Worker secret can only be set on a Worker that exists. Deploy sets a Worker's secrets before it uploads the Worker's code, on a placeholder Worker that answers 503 until the first upload. Without a terminal, the first deploy of a new Worker creates the placeholder, and then fails at the secret, so only the placeholder is live. Run `set`, which writes the value to the placeholder, then deploy again. See [the order of deploy](../providers/cloudflare/workers.md#order-of-deploy). If the secret has a source, the source wins at its next write: on the next deploy for `env` and `dotenv`, and when the version changes for a versioned source.

## `delete`

`delete` deletes a secret from its store. It succeeds if the secret is already gone. It asks for confirmation on a terminal, and needs `--yes` without one.

The next `notation deploy` finds the secret missing and creates it again, from its source or from the prompt. `notation watch` deploys without drift detection, so it doesn't create the secret again. Until `notation deploy` runs, an upload of a Worker that binds the secret fails with Cloudflare error 10182.

## Errors

Both commands fail when:

- No secret has the id. The message lists the declared ids.
- The id is an API token's, whose value only the token's create can write.

`delete` also refuses a secret that a provider adopted rather than created, such as a Cloudflare secret with an explicit `name`.
