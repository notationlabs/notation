# State Store

Notation persists workflow journals, resource state records, and deployment holds in a single SQLite database managed by `@notation/durable`. Every resource mutation runs inside a durable workflow step so the applied-step ledger and state record commit atomically.

## Database Configuration

`NodeDurableRuntime` (`packages/core/src/provisioner/durable-runtime.ts`) resolves the database path from `process.env.NOTATION_DATABASE_PATH`, falling back to `filePaths.database()` (`.notation/workflows.db` under the project root). `projectRoot()` walks upward until it finds `notation.config.ts` or stops at `package.json`, unless overridden by `--config <path>` via `setConfigFile()`.

When opening the database with `node:sqlite` (`DatabaseSync`), `createSqliteDb` from `@notation/durable/sqlite/node` creates parent directories and sets SQLite concurrency pragmas:

```sql [SQLite]
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
```

Passing `databasePath: ":memory:"` creates an ephemeral in-memory database for tests. `readExecutionDeployment()` checks `fs.existsSync(databasePath)` before opening a file-backed database so inspecting an execution ID in an undeployed project never creates an empty file.

## Store Tables

`@notation/durable` stores key-value state alongside step idempotency receipts and read waiters across three SQLite tables:

| Table | Purpose |
| :--- | :--- |
| `stores` | Stores one versioned JSON state row per `store_name` and `store_id` |
| `store_applied_steps` | Records step idempotency receipts for conditional store mutations |
| `store_waiters` | Tracks suspended `takeFromStore` readers and watched JSON paths |

### `stores` Table

Each logical store instance occupies one row in `stores`, identified by both `(store_name, store_id)` and a UUIDv7 `instance_id`:

```sql [SQLite]
CREATE TABLE IF NOT EXISTS stores (
  instance_id TEXT PRIMARY KEY,
  store_name TEXT NOT NULL,
  store_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  state TEXT NOT NULL,
  UNIQUE (store_name, store_id)
);
```

When any operation accesses a missing store, the client generates a fresh UUIDv7 `instance_id` via `createInstanceId()` at `version = 0` from `initial(id)`. Conditional writes (`commitStoreMutation`) and deletions (`commitStoreDeletion`) verify both `instance_id` and `version` inside a transaction:

- **Version compare-and-set** – `UPDATE stores SET version = $version, state = $state WHERE instance_id = $instanceId AND version = $expectedVersion` increments `version` by 1 and asserts `changes === 1`.
- **ABA protection** – Comparing `row.instance_id === expected.instanceId` prevents an ABA race where a store is deleted and recreated under the same `(store_name, store_id)` with an identical version.

### `store_applied_steps` Ledger

Workflow store mutations pass a `StoreStepId` (`{ executionId, stepKey }`) so replays never repeat a compare-and-set against a version that already moved forward:

```sql [SQLite]
CREATE TABLE IF NOT EXISTS store_applied_steps (
  store_name TEXT NOT NULL,
  store_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  step_key TEXT NOT NULL,
  result TEXT NOT NULL,
  PRIMARY KEY (store_name, store_id, execution_id, step_key)
);
```

Inside the same SQLite transaction as the `stores` update or deletion, `commitStoreMutation` and `commitStoreDeletion` check `store_applied_steps` first.

If a receipt exists for `(store_name, store_id, execution_id, step_key)`, the transaction returns `{ status: "already-applied", result }` without modifying `stores`. Receipts survive `deleteStore` and `commitStoreDeletion`, while unmatched `takeFromStore` evaluations are never recorded.

### `store_waiters` Table

When `takeFromStore` returns unmatched, the workflow suspends and registers a versioned read observation in `store_waiters`:

```sql [SQLite]
CREATE TABLE IF NOT EXISTS store_waiters (
  workflow_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  step_key TEXT NOT NULL,
  store_name TEXT NOT NULL,
  store_id TEXT NOT NULL,
  since_version INTEGER NOT NULL,
  read_paths TEXT NOT NULL,
  PRIMARY KEY (store_name, store_id, execution_id, step_key)
);
```

`registerWaiter` upserts the row and immediately wakes the waiter in the same transaction if the store is missing, its `instance_id` changed, or `row.version > waiter.sinceVersion`.

On every subsequent `commitStoreMutation`, `selectMatchingExecutionIds` checks all waiters for `(store_name, store_id)` where `since_version < version` and `storePathsIntersect(read_paths, changedPaths)` is true. Matching executions wake atomically.

## Notation Stores

The durable reconciler (`packages/reconciler/src/durable/stores.ts`) defines two named stores prefixed with `"notation/"`.

### `notation/resource-state`

`resourceStateStore` stores one nullable `ResourceRecord` per deployed resource (`initial: () => null`). Both the outer `resourceRecordSchema` and each entry in `retired` use Valibot's `v.objectWithRest(..., durableValue)`:

```ts [packages/reconciler/src/durable/stores.ts]
const resourceRecordSchema = v.objectWithRest(
  {
    id: v.string(),
    type: v.string(),
    provider: v.string(),
    kind: v.optional(v.literal("credential-source")),
    group: v.nullable(
      v.object({
        type: v.string(),
        id: v.string(),
        parents: v.array(v.object({ type: v.string(), id: v.string() })),
      }),
    ),
    config: durableRecord,
    params: durableRecord,
    output: durableRecord,
    dependsOn: v.optional(v.array(v.string())),
    lastOperation: v.picklist(["creating", "create", "update"]),
    lastOperationAt: v.string(),
    retired: v.optional(v.array(retiredInstanceSchema)),
  },
  durableValue,
);
```

Using `objectWithRest` instead of `v.object` preserves extra driver-persisted fields permitted by the `[key: string]: DurableValue` index signature on `StateNode` and `PersistedResourceState`.

`toStateNode(snapshot)` converts a `ResourceSnapshot` (`StoreSnapshot<ResourceRecord | null>`) into a `StateNode` (`packages/state/src/state.ts`) by merging `version` into `snapshot.state`, or returning `undefined` when `snapshot.state === null`.

During reconciliation, `persistResourceState` (`store.updateFrom`) and `removeResourceState` (`store.deleteFrom`) throw `VersionConflict` (`@notation/state`) if the store moved past the session's `snapshot`. `assertNoRetired` rejects record removal while `retired` is non-empty so superseded instances are never orphaned.

### `notation/deployment-hold`

`deploymentHoldStore` enforces mutual exclusion per deployment (`<app>:<stage>`):

```ts [packages/reconciler/src/durable/stores.ts]
export const deploymentHoldStore = defineStore(
  "notation/deployment-hold",
  v.object({ holder: v.nullable(v.string()) }),
  { initial: () => ({ holder: null }) },
);
```

Hold lifecycle helpers manage ownership through conditional updates:

| Helper | Behavior |
| :--- | :--- |
| `acquireDeploymentHold` | Inspects `notation:hold:inspect` and takes `notation:hold:acquire` |
| `withDeploymentHold` | Releases via `notation:hold:release` on completion or permanent failure |
| `clearDeploymentHold` | Clears an abandoned hold only when `holder === fromExecutionId` |

When another `holderExecutionId` owns the hold, `acquireDeploymentHold` emits `reconciler.hold.waiting` and suspends until `holder === null || holder === opts.executionId`. `withDeploymentHold` leaves the hold intact on `InfrastructureError` or process termination so `--execution-id` resumes keep ownership.

## State Backends

`StateBackend` (`packages/state/src/state.ts`) exposes a read-only interface (`get(id)` and `values()`) because all mutations must run inside checkpointed workflow steps.

### `DurableStateBackend`

`DurableStateBackend` (`packages/reconciler/src/durable/state-backend.ts`) wraps a `@notation/durable` `StoreClient` scoped to one `deploymentId`:

```ts [packages/reconciler/src/durable/state-backend.ts]
export class DurableStateBackend {
  readonly deploymentId: string;
  readonly #client: StoreClient;
  readonly #prefix: string;

  constructor(client: StoreClient, deploymentId: string) {
    this.deploymentId = deploymentId;
    this.#client = client;
    this.#prefix = `${encodeURIComponent(deploymentId)}:`;
  }

  storeId(resourceId: string) {
    return `${this.#prefix}${resourceId}`;
  }
}
```

Prefixing keys with `${encodeURIComponent(deploymentId)}:` keeps deployments disjoint inside a shared `notation/resource-state` table. Orphan cleanup in one deployment cannot read or delete another deployment's stores.

Calling `get(id)` or `snapshot(id)` reads `store(resourceStateStore, storeId(id)).get()`. Because `@notation/durable` initializes missing stores on first access, reading an uncreated resource inserts a `null`-state row, which `toStateNode` maps to `undefined`.

`values()` enumerates all store IDs with `listStores(resourceStateStore)`, filters by `#prefix`, fetches snapshots in parallel, and omits `null` entries.

### `MemoryStateBackend`

`MemoryStateBackend` (`packages/state/src/state.ts`) backs unit tests and offline plan simulation from an in-memory `Record<string, StateNode>` seed.

Initialization and every `get()` or `values()` call deep-clone state via `structuredClone` so callers cannot mutate internal state through shared references. `values()` returns records sorted ascending by `id`.

## Runtime Admission

`NodeDurableRuntime` (`packages/core/src/provisioner/durable-runtime.ts`) coordinates SQLite setup, execution admission, and isolated dispatch for a single workflow run.

Before starting `ExecutionDispatcher`, `run(router, opts)` calls `#admit(opts)` to register `{ executionId, workflowId, params: { ...params, deploymentId: this.deploymentId } }`:

| Condition | Behavior |
| :--- | :--- |
| New execution ID | Admits with `"accepted"` and binds `deploymentId` and `workflowId` |
| Existing execution ID | Loads `ExecutionRecord` on `"EXECUTION_ID_CONFLICT"` and verifies matching IDs |
| Failed prior execution | Refuses resumption so the caller starts a new run from persisted state |
| Changed override flags | Invokes `opts.assertResumable` to reject mismatched overrides on resume |

On `"EXECUTION_ID_CONFLICT"`, `#admit` verifies `record.workflowId === workflowId` and `record.params?.deploymentId === this.deploymentId` before invoking `opts.assertResumable?.(record.params ?? {})`.

After admission succeeds, `NodeDurableRuntime` starts `ExecutionDispatcher` with `concurrency: 1` and `filter: { executionIds: [opts.executionId] }`. Filtering claims strictly to `[opts.executionId]` ensures a process never picks up an unrelated execution in `.notation/workflows.db`.
