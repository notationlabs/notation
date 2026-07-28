# Reconciler

The reconciler expresses deployment and destruction as Yieldstar async generators. Notation owns desired-state decisions and provider lifecycle; the caller's Yieldstar runtime owns durable execution, waiting, and shared state.

## Deploy flow

`deploy` takes the deployment hold, walks dependency levels in order, decides an action for every resource, executes provider calls as durable steps, persists the result in a resource store, and deletes registered orphans.

| Condition | Decision |
| --- | --- |
| Not in state | **create** |
| In state, params changed | **update** |
| In state, params unchanged, no drift | **noop** |
| In state, but deleted from the provider | **drift-recreate** |
| In state, provider state differs from stored state | **drift-update** |
| In state, not in graph | **delete** |

Dry-run deploy performs decisions and emits lifecycle events without provider mutations or state mutations. When drift detection is enabled, it can still call provider read operations to decide whether a nominal noop has drifted.

## Destroy flow

`destroy` is a first-class durable operation. It takes the same deployment hold as deploy, deletes desired resources in reverse dependency order, deletes hydratable persisted orphans, and conditionally removes each resource store only after the provider delete succeeds or reports that the resource is already absent.

Provider delete is a stable durable step, but the provider acknowledgement and Yieldstar heap checkpoint are not atomic. If the process crashes between them, replay repeats the delete, so provider create, update, and delete operations must be idempotent. Event subscribers must likewise tolerate duplicate delivery when a crash occurs before the event checkpoint.

## Waiting and replay

A resource operation throws `ResourceOperationPendingError` when it has not finished. The error gives the reconciler a delay and optional callback context. The runtime stores the context, waits without keeping the process busy, and calls the same operation again. See [Operation errors](./resource.md#operation-errors) for the complete API.

Each attempt, delay, event, state read, state write, and hold change has a stable step key. A resumed execution must use the same execution ID. A new deploy or destroy must use a new execution ID.

## State and the deployment hold

Each resource is stored under `resource-state` with a deployment-scoped ID. Conditional updates and deletes compare the snapshot's UUIDv7 `instanceId` and version, so a stale execution cannot modify a deleted and recreated store.

Deploy and destroy take an exclusive hold on the deployment through one `deployment-hold` store per deployment. `store.take` suspends a competing execution as a durable waiter and wakes it after the holder releases. Before suspending, the waiter emits `reconciler.hold.waiting` naming the holding execution ID, so a wait behind a crashed execution is visible instead of silent.

A failed or suspended execution keeps its hold, which is what makes resuming it safe. The hold of an execution that will never be resumed is cleared with `takeOverDeploymentHold` from `@notation/reconciler/durable` — the only supported way out of that state.

## Events

The durable workflows emit these events:

| Event                                | When                                                |
| ------------------------------------ | --------------------------------------------------- |
| `reconciler.deploy.decision`         | After deciding what action to take for a resource   |
| `reconciler.drift.detected`          | When drift is found between stored and actual state |
| `reconciler.operation.lifecycle`     | When an operation starts, finishes, skips, or fails |
| `reconciler.hold.waiting`            | When another execution holds the deployment         |
| `reconciler.orphan-deletion.skipped` | When no registered class can delete an orphan       |

Lifecycle events cover create, read, update, and delete with `start`, `success`, `error`, `skip`, or `dry-run` status.
