# notation plan

`notation plan` compiles your project and previews every create, update, replace, delete, and credential change without modifying cloud infrastructure or state.

## Usage

Run `notation plan` in your project root to preview `defaultStage`, or pass `--stage` to target another stage:

```sh [Terminal]
@pm.dlx("notation plan")
@pm.dlx("notation plan --stage prod")
```

During a run, `plan` compiles your project into `dist/`, evaluates the resource graph, and runs provider `read` calls for drift detection and credential sources. Unlike [`notation deploy`](./deploy.md), `plan` always compiles and checks drift.

## Options

`notation plan` accepts project, output, and override flags (see [CLI Flags](../reference/cli-flags.md) for syntax and validation rules):

| Flag | Purpose |
| :--- | :--- |
| `--config <path>` | Loads a specific config file instead of the nearest `notation.config.ts` |
| `--stage <stage>` | Targets a specific stage instead of `defaultStage` |
| `--json` | Emits a single `Plan` JSON object on `stdout` |
| `--pretty` | Forces readable terminal lines |
| `--replace <id>[@<hash>]` | Previews replacing a recorded resource with unchanged parameters |
| `--override-loss-protection <id>` | Bypasses class-level `rejectChange` guards for a replaced resource |
| `--credential <id>.<credential>[@<hash>]=<var>` | Previews a manual credential update using `<var>` |

Unlike `deploy`, `@<hash>` is optional on `--replace` and `--credential` during `plan`.

## Output formats

By default, `plan` prints human-readable lines on a TTY or in CI and switches to JSON on non-TTY streams outside CI. In `--json` mode, logs and progress events redirect to `stderr`, leaving a single `Plan` JSON object on `stdout`.

Compare the same plan where `orderQueue` is created and `create-order` updates to reference its URL:

::code-group

```text [pretty]
Compiling infrastructure infra/orders.ts
Compiling runtime modules
Planning orders-app:prod

… read create-order aws/lambda/LambdaFunction
✓ read create-order aws/lambda/LambdaFunction
+ create aws/sqs/Queue orderQueue
~ update aws/lambda/LambdaFunction create-order

Plan: 1 to create, 1 to update, 0 to replace, 0 to recreate, 0 to delete, 0 unchanged.
```

```json [--json]
{
  "createdAt": "2026-11-16T12:00:00.000Z",
  "nodes": [
    {
      "id": "orderQueue",
      "type": "aws/sqs/Queue",
      "decision": "create",
      "params": { "QueueName": { "$unknown": "after-apply" }, "VisibilityTimeout": 30 },
      "dependsOn": []
    },
    {
      "id": "create-order",
      "type": "aws/lambda/LambdaFunction",
      "decision": "update",
      "instanceHash": "9e04b7d1",
      "diff": { "added": { "Environment": { "Variables": { "ORDER_QUEUE_URL": { "$unknown": "after-apply" } } } }, "deleted": {}, "updated": {} },
      "params": { "FunctionName": "orders-app--prod--create-order-a1b2c3d4" },
      "dependsOn": ["orderQueue"]
    }
  ]
}
```

::

Pipe `--json` output directly to tools such as `jq`:

```sh [Terminal]
@pm.dlx("notation plan --stage prod --json") | jq '.nodes[] | {id, decision}'
```

## Reading plan output

Pretty output prefixes each changed resource line with a decision symbol and omits unchanged `noop` nodes:

| Symbol | Meaning |
| :--- | :--- |
| `+` | Creates a missing resource |
| `~` | Updates a resource, applies drift updates, or rotates or passes credentials |
| `+/-` | Replaces a resource create-first |
| `-/+` | Replaces a resource delete-first |
| `±` | Recreates a resource deleted outside Notation |
| `-` | Deletes an orphan or retired instance |

When a kept resource mints or receives credentials without other changes, `plan` prints `~ rotate` or `~ pass`.

## Unknown post-apply values

Values determined only during `notation deploy` – such as generated physical names, outputs of uncreated or replaced dependencies, and rotated credentials – appear in `params` and `diff` as `{ "$unknown": "after-apply" }`.

When a replacement-forcing field is unknown before apply, pretty mode warns that replacement is conditional:

```text [pretty]
-/+ replace aws/eventBridge/rule orders-rule (delete, then create)
    EventBusName unknown, may force replacement
```

## Replacement previews

`plan` shows whether each replacement runs `create-first` (`+/- ... (create, then delete)`) or `delete-first` (`-/+ ... (delete, then create)`), along with any retired instances (`delete-retired`) and cascaded dependent replacements.

This pretty output shows retired instance cleanup, a `delete-first` replacement, and a cascaded dependent replacement:

```text [pretty]
- delete-retired aws/eventBridge/EventBus orders-bus
    the instance that a replace retired at 2026-11-13T00:00:00.000Z, deleted before the resource is replaced
-/+ replace aws/eventBridge/EventBus orders-bus (delete, then create)
    Name forces replacement
-/+ replace aws/eventBridge/rule orders-rule (delete, then create)
    deleted before orders-bus is replaced
```

## Dependency cycles

When resources form a dependency cycle, `plan` marks placeholder members created first without cross-cycle contributions:

```text [pretty]
+ create aws/lambda/LambdaFunction create-order
    created first without the contributions that refer to order-events, the other members of its cycle
```

If no cycle member can act as a placeholder, `plan` fails with `ResourceCycleError`.

## Forced replacements

Pass `--replace <id>` to preview replacing a recorded resource with unchanged parameters.

Add `--override-loss-protection <id>` if the resource class sets `rejectChange`:

```sh [Terminal]
@pm.dlx("notation plan --stage prod --replace lambda:orders:role --override-loss-protection lambda:orders:role")
```

When any override flag is passed, `plan` prints a ready-to-run `notation deploy` command with the resolved `@<instanceHash>` values:

```text [pretty]
+/- replace aws/lambda/LambdaIamRole lambda:orders:role (create, then delete)
    replaced by --replace
~ update aws/lambda/LambdaFunction lambda:orders

Plan: 0 to create, 1 to update, 1 to replace, 0 to recreate, 0 to delete, 0 unchanged.

To deploy this plan:
  notation deploy --stage prod --replace lambda:orders:role@3c1f9a02 --override-loss-protection lambda:orders:role
```

`plan` rejects `--replace` when the resource is missing from code or state, has an unfinished create, or is a credential source.

## Manual credentials

Notation never persists raw secrets in state. When a new, replaced, or updated consumer needs a non-rotatable credential, `plan` fails with `UnobtainableCredentialError` and prints `--credential` and `--replace` commands.

Pass `--credential <id>.<credential>=<VARIABLE>` to preview downstream diffs before exporting the secret or looking up `@<hash>`:

```sh [Terminal]
@pm.dlx("notation plan --stage prod --credential webhook-app.signingSecret=WEBHOOK_APP_SIGNING_SECRET")
```

During `plan`, `@<hash>` is optional and the environment variable need not be set, and `plan` prints the resolved `notation deploy` command with `@<instanceHash>`.

## Credential source warnings

`plan` reads each credential source with known parameters and surfaces any warnings with `!` in pretty mode or on `stderr` in `--json` mode:

```text [stderr]
! stripe-key example/EnvSecret STRIPE_KEY is not set.
```

## Unfinished creates

If a previous deploy crashed mid-create, `plan` skips drift detection, preserves any generated physical name, and flags the node for recovery:

```text [pretty]
+ create aws/sqs/Queue orderQueue
    recovers a create that an earlier deploy did not finish
```

## Exit codes

`notation plan` exits with `0` whenever planning succeeds, even when changes are pending. It exits with `1` on compilation errors, validation errors, `ResourceCycleError`, `UnobtainableCredentialError`, or unexpected provider `read` errors.
