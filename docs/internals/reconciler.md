# Reconciler

The reconciler expresses deployment and destruction as YieldStar async generators. Notation owns desired-state decisions and provider lifecycle; the caller's YieldStar runtime owns durable execution, waiting, shared state, and coordination.

## Deploy flow

`deployWithYieldStar` acquires the deployment coordination store, walks dependency levels in order, decides an action for every resource, executes provider calls as durable steps, persists the result in a resource store, and deletes registered orphans.

| Condition | Decision |
| --- | --- |
| Not in state | **create** |
| In state, params changed | **update** |
| In state, params unchanged, no drift | **noop** |
| In state, but deleted from the provider | **drift-recreate** |
| In state, provider state differs from stored state | **drift-update** |
| In state, not in graph | **delete** |

Dry-run deploy performs decisions and emits lifecycle events without calling providers or mutating state.

## Destroy flow

`destroyWithYieldStar` is a first-class durable operation. It acquires the same deployment coordination store as deploy, deletes desired resources in reverse dependency order, deletes hydratable persisted orphans, and conditionally removes each resource store only after the provider delete succeeds or reports that the resource is already absent.

Provider delete is a stable durable step. If the process crashes after the provider acknowledges deletion but before state removal, replay uses the cached delete result and continues at the conditional store delete.

## Waiting and replay

Retryable provider errors become YieldStar `RetryableError` delays. The resident Node runtime can remain idle until the SQLite timer queues a wake-up, then rebuild the resource graph and replay completed heap steps. Reads that wait for provider consistency use the same mechanism.

Every provider call, event emission, state read, state write, and coordination transition has a stable step key. A resumed execution must use the same execution ID. A new deploy or destroy must use a new execution ID so its heap does not alias an earlier operation.

## State and coordination

Each resource is stored under `notation/resource-state` with a deployment-scoped ID. Conditional updates and deletes compare the snapshot's UUIDv7 `instanceId` and version, so a stale execution cannot modify a deleted and recreated store.

Deploy and destroy share one `notation/deployment-coordination` store per deployment. `store.take` suspends a competing execution as a durable waiter and wakes it after the holder releases. Before suspending, the waiter emits `reconciler.coordination.waiting` naming the holding execution ID, so a wait behind a crashed execution is visible instead of silent.

## Events

The durable workflows emit `reconciler.deploy.decision`, `reconciler.drift.detected`, `reconciler.operation.lifecycle`, `reconciler.coordination.waiting`, and `reconciler.orphan-deletion.skipped`. Lifecycle events cover create, read, update, and delete with `start`, `success`, `error`, `skip`, or `dry-run` status.
