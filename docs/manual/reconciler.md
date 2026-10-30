# Reconciler

Use `deploy` and `destroy` when a Node.js application needs durable resource lifecycle operations without starting the Notation CLI. Notation owns reconciliation intent, graph ordering, provider calls, and resource state; the application owns the outer Yieldstar workflow and runtime.

```ts
import { EventEmitter } from "node:events";
import { ExecutionDispatcher, WorkflowRunner } from "@yieldstar/core";
import { SqliteRuntime, createSqliteDb } from "@yieldstar/sqlite-runtime/node";
import {
  DurableStateBackend,
  deploy as deployResources,
  destroy as destroyResources,
} from "@notation/reconciler/durable";
import pino from "pino";
import { createWorkflowRouter, workflow } from "yieldstar";

const logger = pino();
const runtime = new SqliteRuntime(
  createSqliteDb({ path: ".notation/workflows.db" }),
);
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

const runner = new WorkflowRunner(runtime, {
  router: createWorkflowRouter({ deploy, destroy }),
  logger,
});
const dispatcher = new ExecutionDispatcher(runtime, {
  invoker: {
    workflowEndEmitter: new EventEmitter(),
    deliver: (event, options) => runner.run(event, options),
  },
  logger,
});
dispatcher.start();
```

The outer workflow supplies durable step execution, timers, shared stores, waiting, and scheduling. Checkpointed provider results are replayed from the heap after a crash, retryable provider conditions suspend on a durable timer, and conditional state writes use Yieldstar store identity and version. Provider operations and event consumers are bound by the crash-window contract stated in [the reconciler internals](../internals/reconciler.md#waiting-and-replay).

Each live resource is one Yieldstar store. Yieldstar's UUIDv7 store `instanceId` and version are authoritative for conditional update and delete; Notation exposes the version unchanged as the resource state's `version`.

Operations against the same deployment — the `deploymentId` the `DurableStateBackend` is constructed with, which the CLI sets to `<app>:<stage>:<entry>` — are serialized through a deployment hold naming the holding `executionId`. Resume a crashed operation with the same execution ID; use a new globally unique execution ID for every new deploy or destroy. A `failed` execution is final: Yieldstar never runs it again, and the execution releases its hold when it fails. To recover, start a new deploy, which plans from persisted state and skips the resources that already converged. An execution that must wait emits a `reconciler.hold.waiting` event naming the holder before it suspends, which also identifies a crashed holder that should be resumed instead. If you give up on an execution that has not ended, clear its hold with `clearDeploymentHold`.

Every value the runtime records must be a Yieldstar 0.8.0 durable value, including provider operation results and resource output. A `Date`, `Map`, `Set` or `bigint` is recorded as it is. A provider that returns a `Buffer` or another class instance fails the step with a `WorkflowValueError` whose code is `INVALID_STEP_VALUE`.

Pass the complete desired set on every deployment. Persisted resources absent from that set are deleted through the supplied resource registry, in reverse order of the dependencies recorded in their state. Destroy removes any persisted orphans whose resource type is registered, and then removes current resources in reverse dependency order. A current resource that an unregistered orphan depends on is left in place.

The runnable Node SQLite composition is in `examples/reconciler`.
