# Introduction

Notation is a build-time framework for composing and deploying AWS Lambda services. It compiles TypeScript infrastructure definitions and runtime handlers into a resource graph, diffs that graph against deployed state, and deploys the changes in dependency order. Infrastructure and runtime live in the same codebase, connected by end-to-end types that flow from resource definitions through to handler signatures.

```ts
import { api, router } from "@notation/aws/api-gateway";
import { getTodos } from "../runtime/todos.fn";

const todoApi = api({ name: "todo-api" });
const todoRouter = router(todoApi);
todoRouter.get("/todos", getTodos);
```

Notation is a compiler, reconciler, and deployment engine. 

The compiler runs two passes over your codebase: 

1. An infrastructure pass that resolves resource declarations into a graph, 
2. A function pass that bundles each `.fn.ts` module into a deployable Lambda artifact. 

The reconciler diffs the compiled graph against persisted state and produces a plan. The deployment engine executes that plan, provisioning, updating, or destroying resources in the correct order.

## Core capabilities

- **Compiled resource graphs**: infrastructure definitions compile to a dependency-ordered graph of AWS resources, with intermediate resources such as IAM roles, permissions, and integrations inferred automatically.
- **End-to-end types**: handler exports are typed references that infrastructure modules import directly. Any infra connecting to runtime modules (route bindings, event sources, Lambda configurations etc.) get checked at compile time.
- **Incremental deploys**: the reconciler diffs compiled state against deployed state and deploys only what changed.
- **Watch mode**: file changes trigger a recompilation, reconcilation and a targeted redeployment of affected resources.
- **Visualization**: `notation viz` renders the resource graph as a Mermaid chart so you can inspect what will be deployed.
