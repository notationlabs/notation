# Reconciler

The reconciler runs deployment operations to transition infrastructure from its current state to the state defined in the project.

Source: `@notation/reconciler`

## Durable workflow boundary

`reconcileWithYieldStar` is the durable Node.js integration. It is an async generator intended to be composed inside an application-owned YieldStar workflow:

```ts
const deploy = workflow(async function* (step, event) {
  yield* reconcileWithYieldStar(step, {
    deploymentId: "production",
    executionId: event.executionId,
    resources,
    state,
  });
});
```

The host owns runtime wiring and scheduling. Notation owns graph ordering, decisions, provider calls, drift reads, state persistence, and orphan lifecycle. Provider calls and state mutations are YieldStar steps, so completed calls are replayed instead of repeated after a process crash.

The synchronous `Reconciler` described below remains the CLI path for this release.

## Deploy flow

```ts [packages/reconciler/src/index.ts]
const reconciler = new Reconciler({ state, registry, emit });
await reconciler.deploy(resources, { dryRun, driftDetection });
```

The reconciler walks the resource graph and, for each resource, determines an action:

| Condition                                     | Decision           |
| --------------------------------------------- | ------------------ |
| Not in state                                  | **create**         |
| In state, params changed                      | **update**         |
| In state, params unchanged, no drift          | **noop**           |
| In state, but deleted from AWS                | **drift-recreate** |
| In state, AWS state differs from stored state | **drift-update**   |
| In state, not in graph (orphan)               | **delete**         |

The `dryRun` flag runs the full diffing pipeline without executing any operations, so you can preview what a deploy would do.

## Topological ordering

Resources are deployed in dependency order using `buildResourceDepthLevels()`. This function partitions the resource graph into levels – each level contains resources whose dependencies have all been satisfied by previous levels.

```
Level 0: IAM Role, CloudWatch LogGroup
Level 1: Lambda Function (depends on Role, LogGroup)
Level 2: API Gateway Integration (depends on Lambda)
Level 3: API Gateway Route (depends on Integration)
```

Resources within a level deploy concurrently, so independent resources like the IAM Role and LogGroup above are provisioned in parallel. Dependent resources wait for their dependencies.

Destroy operates in reverse order with dependents getting removed before their dependencies.

### Cycle detection

Cycle detection is built in. If resources form a circular dependency, the build fails with:

```
Resource dependency cycle detected
```

This catches configuration errors before any cloud operations are attempted.

## Drift detection

Drift detection is enabled by default. After confirming no local changes to a resource, the reconciler reads the resource's current state from AWS (via the resource's `read()` operation) and diffs it against stored state.

If AWS has drifted (e.g. someone changed a Lambda timeout in the console, or an IAM policy was modified by another tool), Notation updates the resource to match the canoncial definition in the source code.

Properties marked as `volatile` in the schema (like `LastModified` timestamps) are excluded from drift comparison.

## Events

The reconciler emits events at each step of an operation's lifecycle. The default `createConsoleReconcilerSubscriber()` logs these to the console with formatted output.

| Event                                | When                                                |
| ------------------------------------ | --------------------------------------------------- |
| `reconciler.deploy.decision`         | After deciding what action to take for a resource   |
| `reconciler.drift.detected`          | When drift is found between stored and actual state |
| `reconciler.operation.lifecycle`     | When an operation starts, finishes, skips, or fails |
| `reconciler.orphan-deletion.skipped` | When no registered class can delete an orphan       |

Lifecycle events contain the operation (`create`, `read`, `update`, or `delete`) and its
status (`start`, `success`, `error`, `skip`, or `dry-run`). Events carry the resource ID,
type, and relevant diff or error details.

## Operations

Each CRUD operation is implemented as an async generator with retry support:

- **`createResourceOperation`** – creates the resource, reads back its state, persists to state backend
- **`updateResourceOperation`** – applies the update, reads back new state, persists to state backend
- **`deleteResourceOperation`** – deletes the resource, removes the entry from state backend
- **`readResourceOperation`** – reads current state from the cloud provider (used for drift detection)

### Retry and polling

Operations support polling for eventual consistency:

```ts [packages/reconciler/src/index.ts]
{
  maxAttempts: 10,
  retryInterval: 2000,
}
```

This handles AWS services that return success before the resource is fully available. For example, after creating an IAM Role, a Lambda function may briefly fail to deploy until the role propagates. The retry loop handles cases like this.

### Operation lifecycle

Each operation follows the following pattern:

1. Emit `started` event
2. Execute the cloud operation (with retries)
3. Read back the resource state
4. Persist to state backend
5. Emit `completed` event (or `failed` on error)

State is updated after the provider operation and read-back complete.
