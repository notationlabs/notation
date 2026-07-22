# RFC: Durable YieldStar reconciliation

**Status:** implemented
**Scope:** `@notation/reconciler`, `@notation/core`, YieldStar 0.5.0

Notation describes reconciliation intent and resource lifecycle operations. An outer YieldStar workflow supplies durable execution, waiting, state, and coordination by composing `deployWithYieldStar` or `destroyWithYieldStar`.

## Boundary

Live resource objects remain in the workflow process. They are not serialized into workflow parameters. This keeps provider clients and operation closures under Notation's lifecycle control while YieldStar persists step results and shared state.

Provider create, update, read, and delete calls are durable steps with stable resource-scoped keys. A process crash after a completed provider call replays the cached result and continues at state persistence instead of repeating the call. Retryable provider conditions become YieldStar delays, allowing the process to wait without polling the provider continuously.

## State lifecycle

`YieldStarStateBackend` stores one live resource per `notation/resource-state` store. The store ID is scoped by deployment and resource ID. Store absence is resource absence.

The runtime-assigned UUIDv7 `instanceId` distinguishes a deleted store from a later store created under the same logical ID. YieldStar's version is the concurrency token and is exposed as Notation's one-based `rev`. Workflow updates use `store.updateFrom` and deletes use `store.deleteFrom`, so both the instance and version must match the snapshot that informed the operation.

## Coordination

Each deployment has a `notation/deployment-coordination` store shared by deploy and destroy. The workflow atomically claims it with `store.take`. A concurrent execution suspends as a durable waiter and is woken when the holder releases the store. The same execution can recover an acquisition across the store-commit and heap-write crash gap through YieldStar's applied-step ledger.

## Node CLI runtime

`NodeYieldStarRuntime` wires `WorkflowRunner`, `SqliteHeapClient`, `SqliteStoreClient`, `SqliteSchedulerClient`, and `SqliteEventLoop` against one Node SQLite database. CLI deploy and destroy run through this resident runtime and wait for a workflow result across timer and store wake-ups.

The CLI prints a new execution ID for each operation. Re-running with `--execution-id <id>` resumes that operation from its durable heap after a process crash.
