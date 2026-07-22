# RFC: Durable YieldStar reconciliation

**Status:** implemented release slice
**Scope:** `@notation/reconciler`, YieldStar 0.5.0

Notation describes reconciliation and resource lifecycle operations. A host-owned YieldStar workflow supplies durable execution, waiting, state, and coordination by calling `yield* reconcileWithYieldStar(step, options)`.

## Boundary

Live resource objects remain in the workflow worker. They are not serialized into workflow parameters. This keeps provider clients and operation closures under application control while YieldStar persists step results and shared state.

Provider create, update, read, and delete calls are durable steps with stable resource-scoped keys. A process crash after a completed create replays the cached result and continues at state persistence instead of creating the provider resource again. Retryable provider conditions become YieldStar delays, allowing the process to stop until the scheduler wakes the execution.

## State lifecycle

`YieldStarStateBackend` stores one live resource per `notation/resource-state` store. The store ID is scoped by deployment and resource ID. Store absence is resource absence; no application tombstone is created.

The runtime-assigned UUIDv7 `instanceId` distinguishes a deleted store from a later store created under the same logical ID. YieldStar's version is the concurrency token and is exposed as Notation's one-based `rev`. Workflow updates use `store.updateFrom` and deletes use `store.deleteFrom`, so both the instance and version must match the snapshot that informed the operation.

`values` uses YieldStar 0.5.0's merged `listStores` lifecycle API, and administrative cleanup uses `deleteStore`.

## Coordination

Each deployment has a `notation/deployment-coordination` store. The workflow atomically claims it with `store.take`. A concurrent execution suspends as a durable waiter and is woken when the holder releases the store. The same execution can recover an acquisition across the store-commit/heap-write crash gap through YieldStar's applied-step ledger.

## Release boundary

This slice delivers durable deploy reconciliation, drift handling, orphan deletion, Node SQLite execution, external state access, conditional persistence, and concurrent deployment serialization. The existing synchronous `Reconciler` remains the CLI execution path in this release.

The next stacked phase will move CLI deploy and destroy onto a resident workflow runtime, add durable destroy as a first-class workflow operation, and fan independent dependency-level resources into coordinated child executions.
