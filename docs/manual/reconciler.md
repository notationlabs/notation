# Reconciler

Use `deploy` and `destroy` when a Node.js application needs durable resource lifecycle operations without starting the Notation CLI. Notation owns reconciliation intent, graph ordering, provider calls, and resource state; the application owns the outer Yieldstar workflow and runtime.

```ts
import { SqliteSchedulerClient, SqliteStoreClient, SqliteTaskQueueClient, SqliteTimersClient, createSqliteDb } from "@yieldstar/sqlite-runtime/node";
import { DurableStateBackend, deploy as deployResources, destroy as destroyResources } from "@notation/reconciler";
import { workflow } from "yieldstar";

const database = createSqliteDb({ path: ".notation/workflows.db" });
const schedulerClient = new SqliteSchedulerClient({
  taskQueueClient: new SqliteTaskQueueClient(database),
  timersClient: new SqliteTimersClient(database),
});
const storeClient = new SqliteStoreClient({ db: database, schedulerClient });
const state = new DurableStateBackend(storeClient, "my-application");

export const deploy = workflow(async function* (step, event) {
  yield* deployResources(step, {
    deploymentId: "my-application",
    executionId: event.executionId,
    resources,
    state,
  });
});

export const destroy = workflow(async function* (step, event) {
  yield* destroyResources(step, {
    deploymentId: "my-application",
    executionId: event.executionId,
    resources,
    state,
  });
});
```

The outer workflow supplies durable step execution, timers, shared stores, waiting, scheduling, and coordination. Checkpointed provider results are replayed from the heap after a crash, retryable provider conditions suspend on a durable timer, and conditional state writes use Yieldstar store identity and version. Provider mutations must be idempotent because a crash after provider acknowledgement but before the heap checkpoint repeats the call; event consumers must tolerate the same duplicate-delivery window.

Each live resource is one Yieldstar store. Absence is represented by no store, not a tombstone. Yieldstar's UUIDv7 store `instanceId` and version are authoritative for conditional update and delete; Notation exposes the version as the resource state's `rev`.

Operations against the same `deploymentId` are serialized through a coordination store keyed by `executionId`. Resume a crashed operation with the same execution ID; use a new globally unique execution ID for every new deploy or destroy. An execution that must wait emits a `reconciler.coordination.waiting` event naming the holder before it suspends, which also identifies a crashed holder that should be resumed instead.

Pass the complete desired set on every deployment. Persisted resources absent from that set are deleted through the supplied resource registry. Destroy removes current resources in reverse dependency order and then removes any persisted orphans that the registry can hydrate.

The runnable Node SQLite composition is in `examples/reconciler`.
