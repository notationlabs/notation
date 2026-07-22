# Reconciler

Use `reconcileWithYieldStar` when a Node.js application needs durable resource reconciliation without starting the Notation CLI. Notation supplies reconciliation decisions and resource lifecycle operations; the application owns the outer YieldStar workflow and chooses the runtime.

```ts
import { SqliteSchedulerClient, SqliteStoreClient, SqliteTaskQueueClient, SqliteTimersClient, createSqliteDb } from "@yieldstar/sqlite-runtime/node";
import { YieldStarStateBackend, reconcileWithYieldStar } from "@notation/reconciler";
import { workflow } from "yieldstar";

const database = createSqliteDb({ path: ".notation/workflows.db" });
const schedulerClient = new SqliteSchedulerClient({
  taskQueueClient: new SqliteTaskQueueClient(database),
  timersClient: new SqliteTimersClient(database),
});
const storeClient = new SqliteStoreClient({ db: database, schedulerClient });
const state = new YieldStarStateBackend(storeClient, "my-application");

export const deploy = workflow(async function* (step, event) {
  yield* reconcileWithYieldStar(step, {
    deploymentId: "my-application",
    executionId: event.executionId,
    resources,
    state,
  });
});
```

The outer workflow supplies durable step execution, timers, shared stores, waiting, and scheduling. `reconcileWithYieldStar` uses those primitives to cache completed provider calls, retry provider waiting without holding a process, persist state conditionally, delete state conditionally, and serialize deployments with `store.take`.

Each live resource is one YieldStar store. Absence is represented by no store, not a tombstone. YieldStar's UUIDv7 store `instanceId` and version are authoritative for conditional update and delete; Notation exposes the version as the resource state's `rev` for its existing state contract.

Deployments against the same `deploymentId` are serialized through a coordination store keyed by `executionId`. If a deployment crashes while holding the coordination store, resume it by running the same execution ID again: replay reclaims the acquisition through YieldStar's applied-step ledger and releases it on completion. A different execution ID waits durably until the holder releases.

Pass the complete desired set on every invocation. Persisted resources absent from that set are deleted through the supplied resource registry.

The runnable Node SQLite version is in `examples/reconciler`.
