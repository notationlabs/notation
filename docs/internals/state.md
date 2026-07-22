# State

Notation CLI deploy, destroy, plan, and dashboard use Yieldstar 0.5.0 stores in `.notation/workflows.db`. Override the database path with `NOTATION_STATE_PATH`.

Each live resource is a `notation/resource-state` store scoped by deployment and resource ID. A missing store means the resource is absent. No application tombstone is written.

```ts
const state = new DurableStateBackend(storeClient, "infra/api.ts");
```

The runtime assigns a UUIDv7 `instanceId` when a store is created and increments its version on update. Conditional workflow updates and deletes compare both values, preventing a stale snapshot from modifying a deleted and recreated resource. The one-based value exposed as `StateNode.rev` is derived from the authoritative Yieldstar store version.

```ts
interface StateBackend {
  get(id: string): Promise<StateNode | undefined>;
  has(id: string): Promise<boolean>;
  update(id: string, expectedRev: number, patch: Partial<StateNode>): Promise<{ rev: number }>;
  delete(id: string, expectedRev: number): Promise<void>;
  values(): Promise<StateNode[]>;
}
```

Coordination is not part of the state backend contract. The outer Yieldstar workflow serializes deploy and destroy through a deployment coordination store and records applied store steps for crash-safe replay.

`MemoryStateBackend`, `FileStateBackend`, and `SqliteStateBackend` remain data adapters for tests and embedded read/write consumers. They are not CLI execution runtimes and do not provide mutation coordination.
