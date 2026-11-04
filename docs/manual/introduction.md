# Introduction

Notation is a build-time framework for composing and deploying AWS Lambda services. It compiles TypeScript infrastructure definitions and runtime handlers into a resource graph, diffs that graph against deployed state, and deploys the changes in dependency order. Infrastructure and runtime live in the same codebase, connected by end-to-end types that flow from resource definitions through to handler signatures.

```ts
import { api, router } from "@notation/aws/api-gateway";
import { getTodos } from "../runtime/todos.fn" with { type: "runtime" };

const todoApi = api({ name: "todo-api" });
const todoRouter = router(todoApi);
todoRouter.get("/todos", getTodos);
```

Notation is a compiler, reconciler, and deployment engine.

The reconciler is also available as an embedded library. A Node.js host can construct resources and compose durable reconciliation inside its own Yieldstar workflow without the CLI.

The compiler builds your codebase in two steps:

1. It runs the infra modules, and then the `lambda()` calls of the runtime modules, to build the resource graph.
2. It bundles the code of each Lambda function that a `lambda()` call declares.

The reconciler diffs the compiled graph against persisted state and produces a plan. The deployment engine executes that plan, provisioning, updating, or destroying resources in the correct order.

## Core capabilities

- **Compiled resource graphs**: infrastructure definitions compile to a dependency-ordered graph of AWS resources, with intermediate resources such as IAM roles, permissions, and integrations inferred automatically.
- **End-to-end types**: infra imports runtime modules `with { type: "runtime" }` and sees each handler as a reference that it can wire but not call. Runtime code imports infra `with { type: "infra" }` and reads values such as a queue's URL as plain strings. TypeScript checks both directions.
- **Incremental deploys**: the reconciler diffs compiled state against deployed state and deploys only what changed.
- **Watch mode**: file changes trigger a recompilation, reconcilation and a targeted redeployment of affected resources.
- **Visualization**: `notation viz` renders the resource graph as a Mermaid chart so you can inspect what will be deployed.
