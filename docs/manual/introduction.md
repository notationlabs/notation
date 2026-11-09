# Introduction

Notation is a build-time framework for composing and deploying AWS Lambda services. It compiles TypeScript infrastructure definitions and runtime handlers into a resource graph, diffs that graph against deployed state, and deploys the changes in dependency order. Infrastructure and runtime live in the same codebase. Each runtime module declares the Lambda function that it deploys as, and infra wires that declaration to routes, queues and schedules.

```ts
import { api, router } from "@notation/aws/api-gateway";
import { lambda as todos } from "../runtime/todos";

const todoApi = api({ id: "todo-api" });
const todoRouter = router(todoApi);
todoRouter.get("/todos", () => todos);
```

Notation is a compiler, reconciler, and deployment engine.

The reconciler is also available as an embedded library. A Node.js host can construct resources and compose durable reconciliation inside its own `@notation/durable` workflow without the CLI.

The compiler runs two passes over your codebase:

1. An infrastructure pass that resolves resource declarations into a graph,
2. A runtime pass that bundles each runtime module into the code for one Lambda function, without the infra code.

The reconciler diffs the compiled graph against persisted state and produces a plan. The deployment engine executes that plan, provisioning, updating, or destroying resources in the correct order.

## Core capabilities

- **Compiled resource graphs**: infrastructure definitions compile to a dependency-ordered graph of AWS resources, with intermediate resources such as IAM roles, permissions, and integrations inferred automatically.
- **End-to-end types**: infra imports a runtime module's declaration and wires it to routes, queues and schedules. TypeScript checks that the declaration's event matches what each one sends, and the declaration types the handler and the values that it reads.
- **Incremental deploys**: the reconciler diffs compiled state against deployed state and deploys only what changed.
- **Watch mode**: file changes trigger a recompilation, reconcilation and a targeted redeployment of affected resources.
- **Visualization**: `notation viz` renders the resource graph as a Mermaid chart so you can inspect what will be deployed.
