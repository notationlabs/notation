# Reconciler

The reconciler expresses deployment and destruction as Yieldstar async generators. Notation owns desired-state decisions and provider lifecycle; the caller's Yieldstar runtime owns durable execution, waiting, and shared state.

## Deploy flow

`deploy` takes the deployment hold, walks dependency levels in order, decides an action for every resource, executes provider calls as durable steps, persists the result in a resource store, and deletes registered orphans.

| Condition                                                                                | Decision           |
| ---------------------------------------------------------------------------------------- | ------------------ |
| Not in state                                                                             | **create**         |
| In state, params changed                                                                 | **update**         |
| In state, an immutable or key param changed, or any param of a resource with no `update` | **replace**        |
| In state, params unchanged, no drift                                                     | **noop**           |
| In state, but deleted from the provider                                                  | **drift-recreate** |
| In state, provider state differs from stored state                                       | **drift-update**   |
| In state, provider state differs in an immutable or key param                            | **drift-replace**  |
| In state, not in graph                                                                   | **delete-orphan**  |

The change decision comes from the resource schema, through `diffParams` in `@notation/resource`. It compares comparable params (`param` items that are not `volatile` or `hidden`) field by field. A changed field forces replacement when its schema item is `immutable`, `primaryKey` or `secondaryKey`, or when the resource has no `update` operation. A change anywhere inside such a field replaces the whole resource.

An `undefined` param counts as absent, so an optional param left unset never looks changed. Drift compares only fields that both the desired params and the read output have: a read need not return every param, and it reports defaults for params left unset, and neither is drift.

Replacement deletes the resource and then creates it again, because a resource usually takes its physical name from its params and the new one would collide with the old. Each half is durable: the delete removes the state record, and the create writes a new one with a new instance ID. A crash anywhere in between resumes where it stopped. If the create fails for good, the resource and its record are both gone, and the next deploy plans **create**.

A plan cannot know params derived from a resource that has not been created yet, and marks them unknown. An unknown immutable or key param plans **replace** with the field marked "unknown, may force replacement". The planner treats a replaced resource's output as unknown, so its dependents show the cascade. Deploy decides again for each resource once its dependencies have converged, with real params, so it replaces only what really changed.

Delete-then-create removes a resource while its dependents still exist. A provider that refuses to delete a resource in use fails the deploy.

Dry-run deploy performs decisions and emits lifecycle events without provider mutations or state mutations. When drift detection is enabled, it can still call provider read operations to decide whether a nominal noop has drifted.

## Destroy flow

`destroy` is a first-class durable operation. It takes the same deployment hold as deploy, deletes desired resources in reverse dependency order, deletes registered persisted orphans, and conditionally removes each resource store only after the provider delete succeeds or reports that the resource is already absent.

## Waiting and replay

Provider calls are stable durable steps, but provider acknowledgement and the Yieldstar heap checkpoint are not atomic. If the process crashes between them, replay repeats the call, so provider create, update, and delete operations must be idempotent. Event subscribers must likewise tolerate duplicate delivery when a crash occurs before the event checkpoint.

A resource operation throws `ResourceOperationPendingError` when it has not finished. The error gives the reconciler a delay and optional callback context. The runtime stores the context, waits without keeping the process busy, and calls the same operation again. See [Operation errors](./resource.md#operation-errors) for the complete API.

Each attempt, delay, event, state read, state write, and hold change has a stable step key. A resumed execution must use the same execution ID. A new deploy or destroy must use a new execution ID.

## State and the deployment hold

Each resource is stored under `notation/resource-state` with a deployment-scoped ID. Conditional updates and deletes compare the snapshot's UUIDv7 `instanceId` and version, so a stale execution cannot modify a deleted and recreated store.

Deploy and destroy take an exclusive hold on the deployment through one `notation/deployment-hold` store per deployment. `store.take` suspends a competing execution as a durable waiter and wakes it after the holder releases. A waiter that finds the hold already taken when it inspects it emits `reconciler.hold.waiting` naming the holding execution ID, so a wait behind a crashed execution is visible instead of silent; a holder that appears only between that inspection and the `take` suspends the waiter without the event.

A failed or suspended execution keeps its hold, which is what makes resuming it safe. The hold of an execution that will never be resumed is cleared with `clearDeploymentHold` from `@notation/reconciler/durable` — the only supported way out of that state.

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
