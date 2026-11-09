# Reconciler

Use `deploy` and `destroy` when a Node.js application needs durable resource lifecycle operations without starting the Notation CLI. Notation owns reconciliation intent, graph ordering, provider calls, and resource state; the application owns the outer `@notation/durable` workflow and runtime.

```ts
import { EventEmitter } from "node:events";
import { ExecutionDispatcher, WorkflowRunner } from "@notation/durable/runtime";
import { SqliteRuntime, createSqliteDb } from "@notation/durable/sqlite/node";
import {
  DurableStateBackend,
  deploy as deployResources,
  destroy as destroyResources,
} from "@notation/reconciler/durable";
import pino from "pino";
import { createWorkflowRouter, workflow } from "@notation/durable";

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

The outer workflow supplies durable step execution, timers, shared stores, waiting, and scheduling. Checkpointed provider results are replayed from the heap after a crash, retryable provider conditions suspend on a durable timer, and conditional state writes use `@notation/durable` store identity and version. A provider call and its checkpoint are not atomic. After a crash between them, replay repeats the call, so update and delete operations must be idempotent, and event consumers must accept duplicate events. Before it repeats a create, the reconciler looks the resource up; see [Unknown create outcomes](../reference/resource.md#unknown-create-outcomes).

Each live resource is one `@notation/durable` store. `@notation/durable`'s UUIDv7 store `instanceId` and version are authoritative for conditional update and delete; Notation exposes the version unchanged as the resource state's `version`.

Each deployment has a `deploymentId`. You pass the `deploymentId` to the `DurableStateBackend` constructor. The CLI sets it to `<app>:<stage>`. Only one deploy or destroy can run against a deployment at a time. Each deployment has a hold, which records the `executionId` of the execution that owns the deployment:

1. When an execution starts, it takes the hold.
2. If another execution has the hold, the new execution emits a `reconciler.hold.waiting` event and suspends. The event names the execution that has the hold.
3. When the execution completes or fails, it releases the hold.

Resume a crashed execution with the same execution ID. Give every new deploy or destroy a new, globally unique execution ID.

A `failed` execution is final, and `@notation/durable` never runs it again. To recover, start a new deploy. The new deploy plans from persisted state and skips the resources that already converged.

An execution that crashed keeps the hold. If a `reconciler.hold.waiting` event names an execution that crashed, resume that execution with its ID. If you don't want to resume it, clear its hold with `clearDeploymentHold`.

Every value the runtime records must be a `@notation/durable` 0.9.0 durable value, including provider operation results and resource output. A `Date`, `Map`, `Set` or `bigint` is recorded as it is. A provider that returns a `Buffer` or another class instance fails the step with a `WorkflowValueError` whose code is `INVALID_STEP_VALUE`.

Pass the complete desired set on every deployment. Persisted resources absent from that set are deleted through the class registered for their type, in reverse order of the dependencies recorded in their state. Destroy removes any persisted orphans whose resource type is registered, and then removes current resources in reverse dependency order. A current resource that an unregistered orphan depends on is left in place. The classes of the resources in the desired set are registered, together with those of the `registry` you pass. `planApp`, `deployApp` and `destroyApp` in `@notation/core` also pass the `resourceClasses` of each provider package that state names. Each state record stores the package that its resource class declares in `resource({ type, provider })`. A record written before provider packages were recorded names none, and is looked up in `@notation/aws.iac` and `@notation/std.iac`. A provider package exports its classes as `resourceClasses`, and adds a `default` condition to its `exports` so that it can be resolved from the project root.

A resource can't change type under the same ID. When a state record has the ID of a resource of another type, plan and deploy fail before any change, and the error names the ID and both types. Give the new resource a new ID: its record is then created, and the old record is deleted as an orphan after it. Destroy deletes such a record through the class registered for the record's type.

The runnable Node SQLite composition is in `examples/reconciler`.
