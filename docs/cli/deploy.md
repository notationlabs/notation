# notation deploy

`notation deploy` compiles your project, checks live drift, and converges cloud resources to match your code. Every run logs an execution ID so interrupted deploys can resume from the last checkpoint.

## Usage

Run `notation deploy` in your project root to deploy `defaultStage`, or pass `--stage` to target another stage:

```sh [Terminal]
notation deploy --stage prod
```

At startup, `deploy` resolves `<app>:<stage>`, builds into `dist/`, and prints the execution ID before running provider operations:

```text [Terminal]
Compiling infrastructure /project/infra/api.ts
Compiling runtime modules
Deploying orders-app:prod
Execution ID 9f3c7e1a-4b2d-4c8e-a105-7d2e4f1a8b30
To resume after a crash, run notation deploy --execution-id 9f3c7e1a-4b2d-4c8e-a105-7d2e4f1a8b30
→ create orders-queue aws/sqs/Queue
… create orders-queue aws/sqs/Queue
✓ create orders-queue aws/sqs/Queue
→ create create-order aws/lambda/LambdaFunction
… create create-order aws/lambda/LambdaFunction
✓ create create-order aws/lambda/LambdaFunction
```

Before modifying resources, `deploy` acquires an exclusive hold on `<app>:<stage>` and waits with a warning if another execution holds it.

## Options

`notation deploy` accepts project, output, execution, and override flags (see [CLI Flags](../reference/cli-flags.md) for syntax and validation rules):

| Flag | Purpose |
| :--- | :--- |
| `--config <path>` | Loads a specific config file instead of the nearest `notation.config.ts` |
| `--stage <stage>` | Targets a specific stage instead of `defaultStage` |
| `--json` | Emits versioned NDJSON events on `stdout` |
| `--pretty` | Forces readable terminal lines |
| `--execution-id <id>` | Resumes an interrupted execution or assigns the execution UUID |
| `--no-compile` | Deploys the existing build in `dist/` without recompiling |
| `--no-drift-detection` | Skips live `read` drift checks for unchanged resources |
| `--replace <id>@<hash>` | Forces replacement of a recorded resource |
| `--override-loss-protection <id>` | Bypasses class-level `rejectChange` guards for a replaced resource |
| `--credential <id>.<credential>@<hash>=<var>` | Supplies a non-rotatable credential from an environment variable |

## Skipping compilation

Pass `--no-compile` to deploy an existing build in `dist/` without recompiling, such as after running [`notation compile`](./compile.md) in CI:

```sh [Terminal]
notation compile --config infra.config.ts
notation deploy --config infra.config.ts --stage prod --no-compile
```

## Skipping drift detection

Pass `--no-drift-detection` to skip live `read` calls for resources whose desired parameters match persisted state while still creating new resources, applying parameter updates, and resolving credential sources:

```sh [Terminal]
notation deploy --stage prod --no-drift-detection
```

## Resuming interrupted deploys

If a deploy stops unexpectedly (`SIGINT`, `SIGKILL`, or host crash), pass the printed UUID to `--execution-id`:

```sh [Terminal]
notation deploy --execution-id 9f3c7e1a-4b2d-4c8e-a105-7d2e4f1a8b30
```

Omit `--stage` when resuming so Notation reads the target stage from state, and either omit override flags to reuse saved overrides or pass the exact same set. Failed executions cannot resume – run `notation deploy` without `--execution-id` to skip already-converged resources, or see [Recovery](../core/recovery.md) if a crashed run left a stale stage hold.

## Forced replacements

Use `--replace <id>@<hash>` to recreate a recorded resource even when its parameters are unchanged. Requiring the 8-character hex stage `@<hash>` prevents running a staging replacement command against production.

First run [`notation plan`](./plan.md) with `--replace <id>` to inspect the impact and print the deploy command with the stage hash:

```sh [Terminal]
notation plan --stage prod --replace orders-queue
```

Copy the printed deploy command with `@<hash>` to execute the replacement:

```sh [Terminal]
notation deploy --stage prod --replace orders-queue@3c1f9a02
```

`deploy` rejects `--replace` when the resource is missing from code or state, has an unfinished create from an earlier crash, or is a credential source. Run `deploy` without `--replace` first to recover an unfinished create.

### Replacement order

Whether triggered by `--replace` or an immutable parameter change, `deploy` executes replacements in one of two orders:

- **Create-first** – Creates the replacement first, updates dependents, and deletes the old instance at the end of the deploy.
- **Delete-first** – Deletes blocking dependents and the existing resource before creating the replacement.

Resources with generated physical names or `replaceCreatesFirst: true` replace create-first; others replace delete-first.

### Loss protection

Resources can define `rejectChange` to guard against destructive replacements.

Pass `--override-loss-protection <id>` with `--replace <id>@<hash>` to bypass that guard:

```sh [Terminal]
notation deploy --stage prod --replace uploads@7b1e52c0 --override-loss-protection uploads
```

`--override-loss-protection` requires `--replace` for the same `<id>` and does not bypass parameter-level `rejectReplace` guards.

## Credential handling

`notation deploy` never prompts on `stdin` and never persists raw secret values to state. Raw values remain only in memory and are scrubbed from error messages.

Depending on the producer resource, credentials resolve in one of three ways:

| Producer | Behavior |
| :--- | :--- |
| Credential source | Reloads values on demand and updates consumers when the revision changes |
| Rotatable credential | Mints a new version automatically when a value is not in memory |
| Non-rotatable credential | Yields a value only at creation and throws `UnobtainableCredentialError` if needed again |

When a non-rotatable credential cannot be obtained, `deploy` prints `UnobtainableCredentialError` with `--credential` and `--replace` commands:

```text [stderr]
`api-gateway` takes `webhook-app.signingSecret`, and the deploy run that received its value has ended. Notation does not store the value, and `custom/webhook-app` has no operation that issues another.

  Issue a new value of `signingSecret` at the provider of `custom/webhook-app`. Then set the environment variable `WEBHOOK_APP_SIGNING_SECRET` to the value, and pass it:
    notation deploy --stage prod --credential webhook-app.signingSecret@5d2e8b17=WEBHOOK_APP_SIGNING_SECRET

  Or replace `webhook-app`. Deploy deletes `webhook-app` and creates it again with a new value, so whatever exists only in the old `webhook-app` is lost:
    notation deploy --stage prod --replace webhook-app@5d2e8b17
```

### Passing credentials

To supply a manually rotated secret without replacing its producer, export it in an environment variable and pass `--credential <id>.<credential>@<hash>=<variable>`:

```sh [Terminal]
export WEBHOOK_APP_SIGNING_SECRET="whsec_..."
notation deploy --stage prod --credential webhook-app.signingSecret@5d2e8b17=WEBHOOK_APP_SIGNING_SECRET
```

Passing a variable name keeps credentials out of shell history and process arguments. `--credential` requires `@<hash>` and a non-empty environment variable, and cannot target credential sources, rotatable credentials, uncreated resources, or resources targeted by `--replace`.

## Output formats

By default, `deploy` renders pretty terminal lines on a TTY or in CI and switches to `"version": 1` NDJSON events when piped outside CI.

Compare how the same deploy events appear in `pretty` mode and `json` mode:

::code-group

```text [pretty]
→ create orders-queue aws/sqs/Queue
… create orders-queue aws/sqs/Queue
✓ create orders-queue aws/sqs/Queue
```

```json [json]
{"version":1,"level":"info","event":"reconciler.deploy.decision","resourceId":"orders-queue","resourceType":"aws/sqs/Queue","decision":"create"}
{"version":1,"level":"info","event":"reconciler.operation.lifecycle","operation":"create","status":"start","resourceId":"orders-queue","resourceType":"aws/sqs/Queue"}
{"version":1,"level":"info","event":"reconciler.operation.lifecycle","operation":"create","status":"success","resourceId":"orders-queue","resourceType":"aws/sqs/Queue"}
```

::

## Exit codes

`notation deploy` exits with `0` when convergence completes and `1` on compilation, validation, credential, hold, or provider errors.
