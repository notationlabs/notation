# Reconciler

Use `deploy` and `destroy` when a Node.js application needs durable resource lifecycle operations without starting the Notation CLI. Notation owns reconciliation intent, graph ordering, provider calls, and resource state; the application owns the outer Yieldstar workflow and runtime.

```ts
import { EventEmitter } from "node:events";
import { ExecutionDispatcher, WorkflowRunner } from "@yieldstar/core";
import { SqliteRuntime, createSqliteDb } from "@yieldstar/sqlite-runtime/node";
import { DurableStateBackend, deploy as deployResources, destroy as destroyResources } from "@notation/reconciler/durable";
import pino from "pino";
import { createWorkflowRouter, workflow } from "yieldstar";

const logger = pino();
const runtime = new SqliteRuntime(createSqliteDb({ path: ".notation/workflows.db" }));
const state = new DurableStateBackend(runtime.stores, "my-application");

export const deploy = workflow(async function* (step, event) {
  yield* deployResources(step, {
    executionId: event.executionId,
    resources,
    state,
  });
});

export const destroy = workflow(async function* (step, event) {
  yield* destroyResources(step, {
    executionId: event.executionId,
    resources,
    state,
  });
});

const runner = new WorkflowRunner(runtime, { router: createWorkflowRouter({ deploy, destroy }), logger });
const dispatcher = new ExecutionDispatcher(runtime, {
  invoker: { workflowEndEmitter: new EventEmitter(), deliver: (event, options) => runner.run(event, options) },
  logger,
});
dispatcher.start();
```

The outer workflow supplies durable step execution, timers, shared stores, waiting, and scheduling. Checkpointed provider results are replayed from the heap after a crash, retryable provider conditions suspend on a durable timer, and conditional state writes use Yieldstar store identity and version. Provider operations and event consumers are bound by the crash-window contract stated in [the reconciler internals](../internals/reconciler.md#waiting-and-replay).

Each live resource is one Yieldstar store. Yieldstar's UUIDv7 store `instanceId` and version are authoritative for conditional update and delete; Notation exposes the version unchanged as the resource state's `version`.

Each deployment has a `deploymentId`. You pass the `deploymentId` to the `DurableStateBackend` constructor. The CLI sets it to `<app>:<stage>`. Only one deploy or destroy can run against a deployment at a time. Each deployment has a hold, which records the `executionId` of the execution that owns the deployment:

1. When an execution starts, it takes the hold.
2. If another execution has the hold, the new execution emits a `reconciler.hold.waiting` event and suspends. The event names the execution that has the hold.
3. When the execution completes or fails, it releases the hold.

Resume a crashed execution with the same execution ID. Give every new deploy or destroy a new, globally unique execution ID.

A `failed` execution is final, and Yieldstar never runs it again. To recover, start a new deploy. The new deploy plans from persisted state and skips the resources that already converged.

An execution that crashed keeps the hold. If a `reconciler.hold.waiting` event names an execution that crashed, resume that execution with its ID. If you don't want to resume it, clear its hold with `clearDeploymentHold`.

Every value the runtime records must be a Yieldstar 0.8.0 durable value, including provider operation results and resource output. A `Date`, `Map`, `Set` or `bigint` is recorded as it is. A provider that returns a `Buffer` or another class instance fails the step with a `WorkflowValueError` whose code is `INVALID_STEP_VALUE`.

Pass the complete desired set on every deployment. Persisted resources absent from that set are deleted through the supplied resource registry, in reverse order of the dependencies recorded in their state. Destroy removes any persisted orphans whose resource type is registered, and then removes current resources in reverse dependency order. A current resource that an unregistered orphan depends on is left in place.

The runnable Node SQLite composition is in `examples/reconciler`.
