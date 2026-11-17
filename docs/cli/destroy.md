# notation destroy

`notation destroy` removes all Notation-managed cloud resources in a stage in reverse dependency order and deletes their state records. Every run logs an execution ID upfront so an interrupted teardown can resume with `--execution-id`.

## Usage

Run `notation destroy` from your project root to tear down `defaultStage`, or pass `--stage` and `--config` to target another deployment:

::code-group

```sh [CLI]
notation destroy
notation destroy --stage prod
notation destroy --config apps/orders/notation.config.ts --stage staging
```

```sh [Package script]
@pm.run("destroy")
@pm.run("destroy", "--stage prod")
```

::

Before deleting resources, `destroy` compiles your entry file and evaluates the graph without declaration checks so validation errors never block teardown.

It then prints `<app>:<stage>`, an execution UUID, and the resume command:

```text [Terminal]
Compiling infrastructure /project/infra/orders.ts
Compiling runtime modules
Destroying orders:dev

Execution ID 7f3e9b1a-4c2d-4a8e-9b1c-2d5e6f7a8b9c
To resume after a crash, run notation destroy --execution-id 7f3e9b1a-4c2d-4a8e-9b1c-2d5e6f7a8b9c
… delete lambda:create-order:role-policy aws/lambda/LambdaRolePolicy
✓ delete lambda:create-order:role-policy aws/lambda/LambdaRolePolicy
… delete lambda:create-order aws/lambda/LambdaFunction
✓ delete lambda:create-order aws/lambda/LambdaFunction
… delete sqs-queue:orders aws/sqs/Queue
✓ delete sqs-queue:orders aws/sqs/Queue
```

Unlike [`notation deploy`](./deploy.md), `notation destroy` always compiles first and bypasses resource loss-protection checks (`rejectChange` and `rejectReplace`).

## Options

`notation destroy` accepts project, output, and execution flags (see [CLI Flags](../reference/cli-flags.md) for syntax and validation rules):

| Flag | Purpose |
| :--- | :--- |
| `--config <path>` | Loads a specific config file instead of the nearest `notation.config.ts` |
| `--stage <stage>` | Targets a specific stage instead of `defaultStage` |
| `--json` | Emits versioned NDJSON events on `stdout` |
| `--pretty` | Forces readable terminal lines |
| `--execution-id <id>` | Resumes an interrupted destroy execution or assigns the execution UUID |

If neither `--stage` nor `defaultStage` is set, the command exits with an error before compiling or acquiring a stage hold.

## JSON output

In JSON mode, `destroy` emits `"version": 1` NDJSON events to `stdout` and sends banners to `stderr`.

Stream structured deletion events in CI or scripts with `--json`:

```sh [Terminal]
notation destroy --stage prod --json
```

Each line on `stdout` represents one reconciler event:

```json [stdout (NDJSON)]
{"version":1,"level":"info","event":"reconciler.operation.lifecycle","operation":"delete","status":"start","resourceId":"lambda:create-order","resourceType":"aws/lambda/LambdaFunction"}
{"version":1,"level":"info","event":"reconciler.operation.lifecycle","operation":"delete","status":"success","resourceId":"lambda:create-order","resourceType":"aws/lambda/LambdaFunction"}
```

## Deletion order

`destroy` acquires an exclusive hold on `<app>:<stage>` and deletes orphans first, then declared resources in reverse dependency order. `destroy` also deletes any retired instances from earlier replacements before deleting the active resource.

## Interrupted creates

If an earlier deploy crashed mid-create, `destroy` checks whether the remote resource exists before cleaning up state. Missing remote resources or unknown keys clean up state without failing.

## Dependency cycles

Resources inside a dependency cycle tear down in reverse deploy order so cross-references detach cleanly during teardown.

## Unregistered resource types

If an orphaned resource's provider package or type cannot be loaded, `destroy` logs a warning and preserves that record and its dependencies. Credential source records are removed without warnings.

## Provider delete behavior

Most resources execute their provider delete APIs directly, with these exceptions:

| Resource type | Behavior |
| :--- | :--- |
| `aws/eventBridge/DefaultEventBus` | Clears only local state and leaves the default bus intact |
| `cloudflare/secrets-store/SecretsStore` | Clears only local state while deleting individual `SecretsStoreSecret` records remotely |
| `cloudflare/containers/ContainerImage` | Clears only local state and keeps pushed registry tags intact |
| `cloudflare/workers/WorkerScript` | Fails deletion if external Workers or Pages projects still bind to it |
| `cloudflare/r2/R2Bucket` | Fails deletion if objects remain in the bucket |

## Resuming an interrupted destroy

If `notation destroy` stops mid-run due to a crash or network failure, pass the printed execution ID to `--execution-id`:

```sh [Terminal]
notation destroy --execution-id 7f3e9b1a-4c2d-4a8e-9b1c-2d5e6f7a8b9c
```

Omit `--stage` when resuming so Notation reads the saved stage from state, and note that only `destroy` execution IDs can resume `notation destroy`. Failed executions cannot resume – fix the blocker and run `notation destroy` without `--execution-id`, or see [Recovery](../core/recovery.md) if a crashed run left a stale stage hold.

## Exit codes

`notation destroy` exits with `0` when all tracked resources and state records are removed and `1` on compilation, admission, credential, or provider errors.
