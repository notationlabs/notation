# Reconciliation

Reconciliation keeps live cloud infrastructure aligned with your TypeScript declarations. Every [`notation plan`](../cli/plan.md) and [`notation deploy`](../cli/deploy.md) evaluates your resource graph, validates constraints, checks for live drift, applies changes in dependency order, and sweeps removed resources.

## First deploy

On an empty stage, `notation plan` compares your declarations against empty state and orders every resource from dependencies to dependents:

```txt [Terminal]
Planning orders:prod

+ create aws/sqs/Queue sqs-queue:orders
+ create aws/lambda/LambdaFunction lambda:process-order

Plan: 2 to create, 0 to update, 0 to replace, 0 to recreate, 0 to delete, 0 unchanged.
```

Running `notation deploy` acquires an exclusive lock on `<app>:<stage>`, creates the queue first, resolves its generated URL and ARN, and then creates the Lambda function.

## In-place updates

When you edit a mutable parameter – such as increasing a Lambda function's `timeout` – Notation updates the existing resource in place without downtime:

```txt [Terminal]
Planning orders:prod

~ update aws/lambda/LambdaFunction lambda:process-order

Plan: 0 to create, 1 to update, 0 to replace, 0 to recreate, 0 to delete, 1 unchanged.
```

Unchanged resources remain `noop` and keep their persisted state and physical names intact.

## Drift detection

When your code matches state, Notation calls `read` on live resources by default to detect manual console edits or out-of-band deletions:

```txt [Terminal]
Planning orders:prod

~ drift-update aws/sqs/Queue sqs-queue:orders
± drift-recreate aws/sqs/Queue sqs-queue:orders-dlq

Plan: 0 to create, 1 to update, 0 to replace, 1 to recreate, 0 to delete, 0 unchanged.
```

Notation ignores provider-applied defaults on unset optional fields.

Skip live checks for faster runs with `--no-drift-detection`:

```sh [Terminal]
notation deploy --no-drift-detection
```

## Safe replacement

Changing an immutable or key parameter (such as switching an SQS queue to `fifo: true`) forces replacement.

Notation picks create-first or delete-first based on whether the new instance can coexist with the old one:

```txt [Terminal]
Planning orders:prod

+/- replace aws/sqs/Queue sqs-queue:orders (create, then delete)
    FifoQueue forces replacement

Plan: 1 to create, 0 to update, 1 to replace, 0 to recreate, 0 to delete, 1 unchanged.
```

- **Create-first (`+/-`)** – Resources with a generated [physical name](./physical-names.md) or coexistable keys create the replacement while the old resource stays live, update downstream dependents in place, and delete the retired instance at the end of the deploy.
- **Delete-first (`-/+`)** – Resources without coexistable identifiers delete blocking dependents in reverse dependency order, delete the target, create the replacement, and redeploy dependents.

If two resources form a circular dependency through optional, non-replacing `contribute()` calls on an updatable resource, Notation creates that resource as a placeholder first and updates it until outputs converge. Unbreakable cycles fail early with `ResourceCycleError`.

## Loss protection

Resources guarded by `rejectChange` or parameter-level `rejectReplace` block destructive updates, forced replacements, or orphan deletions during `plan` and `deploy`.

To intentionally replace a `rejectChange`-protected resource, preview the instance hash with `notation plan --replace <id>` and confirm data loss with `--override-loss-protection`:

```sh [Terminal]
notation plan --stage prod --replace bucket:orders-archive
notation deploy --stage prod --replace bucket:orders-archive@3c1f9a02 --override-loss-protection bucket:orders-archive
```

Parameter-level `rejectReplace` checks cannot be bypassed with `--override-loss-protection`.

## Cleanup

Removing a resource declaration from TypeScript schedules it as `delete-orphan` (`-`) and deletes it in reverse dependency order at the end of `notation deploy`. If an orphan's provider package is no longer available, Notation warns and leaves it in state.

[`notation destroy`](../cli/destroy.md) tears down every resource tracked in a stage in reverse dependency order:

```sh [Terminal]
notation destroy --stage prod
```
