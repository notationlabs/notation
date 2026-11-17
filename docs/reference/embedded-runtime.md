# Embedded Runtime

Programmatic deployments, custom workflows, test harnesses, and state tools interact with Notation through `@notation/core`, `@notation/reconciler`, `@notation/reconciler/durable`, and `@notation/state`.

## Database configuration

`NodeDurableRuntime`, `withRuntime`, `runDurableWorkflow`, and `readExecutionDeployment` (`@notation/core`) resolve the SQLite database path in this order:

1. Explicit `databasePath` option (`":memory:"` for an ephemeral in-memory database).
2. `process.env.NOTATION_DATABASE_PATH`.
3. Default project database path `.notation/workflows.db` under the directory containing `notation.config.ts`.

`readExecutionDeployment(executionId, opts?)` checks whether a file-backed database exists before opening it so lookups on undeployed projects do not create empty database files.

## State records

Persisted resource records and retired instances are typed in `@notation/state`:

```ts [TypeScript]
export type RetiredInstance = {
  config: DurableObject;
  params: DurableObject;
  output: DurableObject;
  dependsOn: string[];
  retiredAt: string;
};

export type StateNode = {
  version: number;
  id: string;
  type: string;
  provider: string;
  kind?: "credential-source";
  config: DurableObject;
  params: DurableObject;
  output: DurableObject;
  dependsOn?: string[];
  lastOperation: "creating" | "create" | "update";
  lastOperationAt: string;
  retired?: RetiredInstance[];
  [key: string]: DurableValue;
};
```

Two state helpers accompany `StateNode` in `@notation/state`:

- **`isCreatingRecord(node)`** – Type guard returning `true` when `node?.lastOperation === "creating"` (an unfinished create written before attempting provider creation).
- **`VersionConflict`** – Error thrown when a conditional write or deletion detects that the backing store version advanced past the read snapshot.

## State backends

State backends implement read-only inspection; state mutations inside durable workflows go through versioned store steps so replays remain idempotent.

### `StateBackend`

`StateBackend` (`@notation/state`) defines the read interface shared by the planner, dashboard, and durable drivers:

```ts [TypeScript]
export interface StateBackend {
  get(id: string): Promise<StateNode | undefined>;
  values(): Promise<StateNode[]>;
}
```

### `DurableStateBackend`

`DurableStateBackend` (`@notation/reconciler/durable`) reads deployment-scoped records from a `@notation/durable` `StoreClient` (`notation/resource-state` store):

```ts [TypeScript]
export class DurableStateBackend implements StateBackend {
  readonly deploymentId: string;

  constructor(client: StoreClient, deploymentId: string);

  storeId(resourceId: string): string;
  get(id: string): Promise<StateNode | undefined>;
  snapshot(id: string): Promise<ResourceSnapshot>;
  values(): Promise<StateNode[]>;
}
```

`storeId(resourceId)` namespaces records as `${encodeURIComponent(deploymentId)}:${resourceId}`. Calling `snapshot(id)` returns the versioned `StoreSnapshot<ResourceRecord | null>` (`state: null` at `version: 0` when absent).

### `MemoryStateBackend`

`MemoryStateBackend` (`@notation/state`) provides an in-memory `StateBackend` for planning, testing, and tooling:

```ts [TypeScript]
export class MemoryStateBackend implements StateBackend {
  constructor(initialState: Record<string, StateNode> = {});

  get(id: string): Promise<StateNode | undefined>;
  values(): Promise<StateNode[]>;
}
```

The constructor and every read deep-clone records via `structuredClone` so external mutations cannot corrupt backend state. `values()` returns records sorted lexicographically by `id`.

## Resource registry

`createResourceRegistry` (`@notation/core`, `@notation/reconciler`) maps `ResourceType` strings to `ResourceClass` constructors for orphan deletion and `blocksDeleteOf` checks when classes are not present in the current infrastructure graph:

```ts [TypeScript]
export type ResourceRegistry = Map<ResourceType, ResourceClass<any, any, any>>;

export function createResourceRegistry(
  entries?: Iterable<ResourceClass<any, any, any>>,
): ResourceRegistry;

export function mergeResourceRegistries(
  ...registries: (ResourceRegistry | undefined)[]
): ResourceRegistry;

export function resolveResourceClass(
  registry: ResourceRegistry,
  type: ResourceType,
): ResourceClass<any, any, any> | undefined;
```

`mergeResourceRegistries` merges registries left to right so later entries override earlier ones; resources declared in code always take precedence over supplied registries.

## Durable runtime

`NodeDurableRuntime` (`@notation/core`) manages a SQLite-backed durable execution engine scoped to one `<app>:<stage>` deployment:

```ts [TypeScript]
export type NodeDurableRuntimeOptions = {
  deployment: DeploymentIdentity;
  databasePath?: string;
  logger?: Logger;
  leaseDuration?: number;
};

export type RunWorkflowOptions = {
  workflowId: string;
  executionId: string;
  params?: Record<string, DurableValue>;
  assertResumable?: (saved: Record<string, unknown>) => void;
};

export class NodeDurableRuntime {
  readonly deployment: DeploymentIdentity;
  readonly deploymentId: string;
  readonly state: DurableStateBackend;

  constructor(opts: NodeDurableRuntimeOptions);

  run(router: WorkflowRouter, opts: RunWorkflowOptions): Promise<unknown>;
  execution(executionId: string): Promise<ExecutionRecord | undefined>;
  close(): void;
}
```

Key runtime behaviors:

- **Deployment key** – `deploymentId` resolves to `${app}:${stage}` (validated via `assertNameSafe`).
- **Single active run** – `run()` throws if another workflow is already running on the same `NodeDurableRuntime` instance.
- **Admission checks** – Before dispatching, `run()` admits `executionId` with `{ ...params, deploymentId }`. On `EXECUTION_ID_CONFLICT`, it verifies matching `workflowId` and `deploymentId`, rejects executions with `outcome.status === "failed"`, and runs `assertResumable?.(record.params ?? {})`.
- **Lease expiration** – `leaseDuration` configures the delivery lease TTL in milliseconds; resuming an execution after an ungraceful process kill waits up to this duration for the previous lease to expire.
- **Closing** – `close()` closes the SQLite connection and throws if a workflow is currently running.

### `withRuntime`

`withRuntime` (`@notation/core`) scopes a `NodeDurableRuntime` around an async callback and closes it automatically when it created the runtime:

```ts [TypeScript]
export async function withRuntime<T>(
  opts: {
    deployment?: DeploymentIdentity;
    runtime?: NodeDurableRuntime;
    databasePath?: string;
  },
  fn: (runtime: NodeDurableRuntime) => Promise<T>,
): Promise<T>;
```

`withRuntime` throws if both `runtime` and `databasePath` are passed, if neither `runtime` nor `deployment` is passed, or if a supplied `runtime.deploymentId` does not match `deployment`. A caller-supplied `runtime` stays open after `fn` finishes.

## Workflow routing

Compose `durable.deploy` and `durable.destroy` (`@notation/reconciler/durable`) inside `@notation/durable` workflow handlers and bind them with `createWorkflowRouter` (`@notation/durable`):

```ts [TypeScript]
import { createWorkflowRouter, workflow } from "@notation/durable";
import { NodeDurableRuntime, createResourceRegistry } from "@notation/core";
import * as durable from "@notation/reconciler/durable";

const runtime = new NodeDurableRuntime({
  deployment: { app: "orders", stage: "prod" },
});

const router = createWorkflowRouter({
  deploy: workflow(async function* (step, event) {
    yield* durable.deploy(step, {
      executionId: event.executionId,
      resources,
      state: runtime.state,
      registry: createResourceRegistry(extraClasses),
      app: "orders",
      stage: "prod",
    });
  }),
  destroy: workflow(async function* (step, event) {
    yield* durable.destroy(step, {
      executionId: event.executionId,
      resources,
      state: runtime.state,
      registry: createResourceRegistry(extraClasses),
    });
  }),
});

try {
  await runtime.run(router, {
    workflowId: "deploy",
    executionId: crypto.randomUUID(),
  });
} finally {
  runtime.close();
}
```

### `runDurableWorkflow`

`runDurableWorkflow` (`@notation/core`) wraps a single generator body with `workflow(...)`, `createWorkflowRouter`, `withRuntime`, and `runtime.run`:

```ts [TypeScript]
export async function runDurableWorkflow(
  opts: {
    deployment?: DeploymentIdentity;
    workflowId: string;
    runtime?: NodeDurableRuntime;
    databasePath?: string;
    executionId: string;
    params?: Record<string, DurableValue>;
    assertResumable?: (saved: Record<string, unknown>) => void;
  },
  body: (
    step: DurableStep,
    executionId: string,
    runtime: NodeDurableRuntime,
    params: Record<string, unknown>,
  ) => AsyncGenerator<any, void, any>,
): Promise<void>;
```

## Deployment holds

`durable.deploy` and `durable.destroy` acquire an exclusive hold in `notation/deployment-hold` per `deploymentId`. Crashed executions that will not be resumed leave the hold occupied until cleared with `clearDeploymentHold` (`@notation/reconciler/durable`):

```ts [TypeScript]
export type DeploymentHoldClearance =
  | { cleared: true; previousHolder: string }
  | { cleared: false; holder: string | null };

export async function clearDeploymentHold(params: {
  storeClient: StoreClient;
  deploymentId: string;
  fromExecutionId: string;
}): Promise<DeploymentHoldClearance>;
```

`clearDeploymentHold` clears the hold conditionally only when `holder === fromExecutionId`:

```ts [TypeScript]
import { SqliteRuntime, createSqliteDb } from "@notation/durable/sqlite/node";
import { clearDeploymentHold } from "@notation/reconciler/durable";

const db = createSqliteDb({ path: ".notation/workflows.db" });
const durableRuntime = new SqliteRuntime(db);

try {
  const result = await clearDeploymentHold({
    storeClient: durableRuntime.stores,
    deploymentId: "orders:prod",
    fromExecutionId: "abandoned-execution-id",
  });
} finally {
  db.close();
}
```

Verify that `fromExecutionId` is dead and will not be resumed before calling `clearDeploymentHold`; clearing an active holder allows concurrent mutations on the same deployment. See [Durable Execution](../internals/durable-execution.md).
