# State

Notation CLI deploy, destroy, plan, and dashboard use Yieldstar stores in `.notation/workflows.db`. Override the database path with `NOTATION_DATABASE_PATH`.

Each live resource is a `notation/resource-state` store scoped by deployment and resource ID. A missing store means the resource is absent. No application tombstone is written.

```ts
const state = new DurableStateBackend(storeClient, "infra/api.ts");
```

The runtime assigns a UUIDv7 `instanceId` when a store is created and increments its version on update. Conditional workflow updates and deletes compare both values, preventing a stale snapshot from modifying a deleted and recreated resource. The store version is exposed unchanged as `StateNode.version`.

`DurableStateBackend` is read-only: state writes happen inside the workflow, through the store handle, so each write is stamped with the step that made it and is not repeated on replay.

The workflow serializes deploy and destroy through one `notation/deployment-hold` store per deployment.
