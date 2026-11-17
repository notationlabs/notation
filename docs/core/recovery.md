# Recovery

When a deployment stops mid-run or hits a missing non-rotatable credential, Notation preserves workflow checkpoints and stage locks in `.notation/workflows.db`. You can resume interrupted runs, adopt unfinished resources, clear stale locks, and apply targeted operator overrides from the CLI.

## Resuming interrupted runs

Before calling any cloud API, [`notation deploy`](../cli/deploy.md) and [`notation destroy`](../cli/destroy.md) print an execution ID and resume command:

```txt [Terminal]
Deploying orders:prod
Execution ID 7f3e9b1a-4c2d-4a8e-9b1c-2d5e6f7a8b9c
To resume after a crash, run notation deploy --execution-id 7f3e9b1a-4c2d-4a8e-9b1c-2d5e6f7a8b9c
```

If the process crashes or loses connectivity, pass `--execution-id` to replay completed checkpoints instead of repeating finished cloud operations:

::code-group

```sh [Resume deploy]
notation deploy --execution-id 7f3e9b1a-4c2d-4a8e-9b1c-2d5e6f7a8b9c
```

```sh [Resume destroy]
notation destroy --execution-id 7f3e9b1a-4c2d-4a8e-9b1c-2d5e6f7a8b9c
```

::

Omit `--stage` when resuming so Notation restores the stage, workflow, and overrides from the saved execution record. Executions that ended in a terminal error cannot resume; fix the underlying cause and start a fresh run instead.

Because plaintext secrets stay strictly in process memory, a resumed run reloads external credential sources automatically and rotates rotatable credentials if an uncompleted consumer needs them.

## Unfinished creates

If a crash occurs right after sending a `create` call, Notation has already persisted the pending resource and any generated physical name. On the next run, Notation recovers automatically:

1. `notation plan` flags the unfinished create for inspection.
2. `notation deploy` queries the provider by its saved name and adopts the live resource into state if found, or completes `create` cleanly if absent.

Any retired instances left behind by an interrupted create-first replacement appear as `delete-retired` in `plan` and retry automatically on the next `deploy`. If a resource was created without saving a required output, the next `deploy` backfills it via `read` (or prompts you to recreate it with `--replace` when `read` is unsupported).

## Stale holds

Before mutating resources, `deploy` and `destroy` acquire an exclusive hold on `<app>:<stage>`. Concurrent runs warn with the holding execution ID and wait for the lock to clear.

Normal completions and terminal errors release the hold automatically, while crashed runs preserve it so `--execution-id` keeps ownership. Always resume the holding execution first; only if that process is permanently lost should you clear the lock via `clearDeploymentHold` (see the [Embedded Runtime Reference](../reference/embedded-runtime.md)).

## Forced replacements

Use `--replace <id>@<hash>` to force replacement of an unchanged resource, adding `--override-loss-protection <id>` if the resource is guarded by `rejectChange`. The 8-character instance hash prevents a command from targeting the wrong resource instance.

Run [`notation plan`](../cli/plan.md) without `@<hash>` first to inspect the change and print the ready-to-run `deploy` command with the resolved hash:

::code-group

```sh [AWS]
notation plan --stage prod --replace sqs-queue:orders
notation deploy --stage prod --replace sqs-queue:orders@3a7f9c12
```

```sh [Cloudflare (protected resource)]
notation plan --stage prod --replace kv:cache
notation deploy --stage prod --replace kv:cache@8e4d1b20 --override-loss-protection kv:cache
```

::

## Manual credentials

When a non-rotatable minted credential is needed by a consumer in a fresh or resumed process, `plan` and `deploy` fail with `UnobtainableCredentialError` and print recovery options.

Pass a replacement value via an environment variable using `--credential <id>.<credential>=<ENV_VAR>` with `plan`, then export the secret and apply with the resolved `@<hash>`:

::code-group

```sh [Preview with plan]
notation plan --stage prod --credential webhook-key.secret=WEBHOOK_KEY_SECRET
```

```sh [Apply with deploy]
export WEBHOOK_KEY_SECRET="whsec_newly_issued_value"
notation deploy --stage prod --credential webhook-key.secret@7b1e52c0=WEBHOOK_KEY_SECRET
```

::

You can also pass `--replace <id>@<hash>` on the credential-minting resource instead of `--credential` to re-mint a fresh secret and update consumers.
