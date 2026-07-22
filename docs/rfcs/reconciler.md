# RFC: Durable Yieldstar reconciliation

**Status:** implemented
**Scope:** `@notation/reconciler`, `@notation/core`, Yieldstar 0.5.0

Notation describes reconciliation intent and resource lifecycle operations. An outer Yieldstar workflow supplies durable execution, waiting, state, and coordination by composing `deploy` or `destroy`.

## Boundary

Live resource objects remain in the workflow process. They are not serialized into workflow parameters. This keeps provider clients and operation closures under Notation's lifecycle control while Yieldstar persists step results and shared state.

Provider create, update, read, and delete calls are durable steps with stable resource-scoped keys. Once a result reaches the heap checkpoint, replay uses the cached result and continues at state persistence. Provider mutations must be idempotent because a crash after provider acknowledgement but before that checkpoint repeats the call. Retryable provider conditions become Yieldstar delays, allowing the process to wait without polling the provider continuously.

## State lifecycle

`DurableStateBackend` stores one live resource per `notation/resource-state` store. The store ID is scoped by deployment and resource ID. Store absence is resource absence.

The runtime-assigned UUIDv7 `instanceId` distinguishes a deleted store from a later store created under the same logical ID. Yieldstar's version is the concurrency token and is exposed as Notation's one-based `rev`. Workflow updates use `store.updateFrom` and deletes use `store.deleteFrom`, so both the instance and version must match the snapshot that informed the operation.

## Coordination

Each deployment has a `notation/deployment-coordination` store shared by deploy and destroy. The workflow atomically claims it with `store.take`. A concurrent execution suspends as a durable waiter and is woken when the holder releases the store. The same execution can recover an acquisition across the store-commit and heap-write crash gap through Yieldstar's applied-step ledger.

## Node CLI runtime

`NodeDurableRuntime` wires `WorkflowRunner`, `SqliteHeapClient`, `SqliteStoreClient`, `SqliteSchedulerClient`, and `SqliteEventLoop` against one Node SQLite database. CLI deploy and destroy run through this resident runtime and wait for a workflow result across timer and store wake-ups.

The CLI prints a new execution ID for each operation. Re-running with `--execution-id <id>` resumes that operation from its durable heap after a process crash.
