# State

Notation stores deployed resource state alongside a durable workflow journal in SQLite. Keeping both in one local database lets interrupted runs resume safely, prevents overlapping writes from corrupting state, and keeps secrets off disk.

## Local database

By default, Notation writes workflow journals and resource records to `.notation/workflows.db` at the project root. Add `.notation/` to `.gitignore` so local state stays out of source control.

Set `NOTATION_DATABASE_PATH` to point Notation at a different path, such as a persistent volume on a CI runner:

```sh [Terminal]
NOTATION_DATABASE_PATH=/var/lib/notation/workflows.db notation deploy --stage prod
```

Inside the database, Notation isolates resource records by deployment (`<app>:<stage>`) and binds each `deploy` and `destroy` run to an execution ID for `--execution-id` recovery (see [Recovery](./recovery.md)).

## Tracked records

Every deployed resource or credential source has a persisted record keyed by its logical `id`:

| Category | Stored data |
| :--- | :--- |
| Identity | Logical `id`, resource `type`, `provider` package, and `group` membership |
| Configuration | Desired inputs, last applied parameters, and provider outputs |
| Dependencies | Sorted `dependsOn` IDs for orphan sweeps and teardown order |
| Lifecycle status | Current operation state and last update timestamp |
| Retired instances | Older instances kept after create-first replacement until deleted |

The persisted `provider` package lets Notation load resource classes during orphan cleanup even after declarations are removed. Deleting a resource removes its record once any retired instances finish deleting.

## Concurrency locks

Notation protects deployment state from concurrent modifications at two levels:

- **Deployment holds** – Every `deploy` and `destroy` acquires an exclusive hold on `<app>:<stage>` before making provider calls, causing overlapping runs to warn and wait.
- **Checkpointed mutations** – State updates execute inside durable workflow steps with optimistic concurrency checks so replayed steps never overwrite newer state.

## Secret markers

Notation never writes plaintext secrets or minted credentials to state records or workflow logs. Minted credentials persist only as opaque version markers, and external credential sources persist hashed revision fingerprints (see [Secrets](./secrets.md)).

## Programmatic runtime

You can inspect read-only state via `StateBackend` (`DurableStateBackend` and `MemoryStateBackend`) or run durable workflows programmatically in Node using `NodeDurableRuntime` and `createWorkflowRouter` (see the [Embedded Runtime Reference](../reference/embedded-runtime.md)).
