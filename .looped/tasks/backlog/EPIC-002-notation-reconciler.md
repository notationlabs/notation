---
type: epic
title: "@notation/reconciler"
created: "2026-02-26T00:54:56.459Z"
updated: "2026-02-26T00:54:56.459Z"
tasks:
  - TASK-004
  - TASK-005
  - TASK-006
priority: high
estimate: large
---
## Declare desired state, detect drift, converge.

## Why

Every infrastructure tool reinvents the same reconciliation loop: read desired state, read actual state, compute diff, apply changes. Terraform does it. Kubernetes controllers do it. ArgoCD does it. They all implement the same algorithm — create if missing, update if drifted, delete if orphaned — but it is always baked into the tool, inseparable from the specific resources it manages.

`@notation/reconciler` extracts this loop into a standalone engine. Give it a list of resources (defined via `@notation/resource`) and a state backend, and it converges reality to match. It handles the hard parts: dependency ordering, drift detection, orphan cleanup, retry with backoff, read-after-write verification.

This enables:

1. **Build your own Terraform.** Not the HCL language — the reconciliation engine. If you can define your resources declaratively (which `@notation/resource` gives you), this package does the rest. Manage cloud infrastructure, SaaS integrations, database schemas, or anything else that has CRUD operations and state.
2. **Continuous conformance.** The same reconciliation loop that deploys infrastructure can enforce behavioral contracts. Define what "correct" looks like, detect drift from that definition, converge back. This is the engine underneath a conformance platform.
3. **Hot infrastructure replacement.** The deploy workflow is designed for tight iteration loops — it diffs locally first (fast), only reads remote state when needed, and skips unchanged resources. This is what made Notation watch mode feel like magic: sub-second deploys when only one resource changed.

---

## What to extract

### Operations

| Source file | What to take |
|---|---|
| `provisioner/operations/operation.base.ts` | `operation()` wrapper (dry-run, logging, error handling) |
| `provisioner/operations/operation.create.ts` | `createResource` — create + read-after-create + state persistence + retry |
| `provisioner/operations/operation.read.ts` | `readResource` — read with retry-on-condition polling |
| `provisioner/operations/operation.update.ts` | `updateResource` — update + read-after-update + state persistence |
| `provisioner/operations/operation.delete.ts` | `deleteResource` — delete with not-found tolerance + state removal |

### Workflows

| Source file | What to take |
|---|---|
| `provisioner/workflows/workflow.deploy.ts` | `deploy` — the full reconciliation loop (create/update/drift-detect/orphan-delete) |
| `provisioner/workflows/workflow.destroy.ts` | `destroy` — tear down all resources in reverse order |
| `provisioner/workflows/workflow.refresh.ts` | `refresh` — delete orphaned state entries |

## What to leave behind

| Thing | Why |
|---|---|
| `getResourceGraph(entryPoint)` calls | Notation-specific: loads a compiled JS file to build the resource graph via import side effects. The reconciler should receive the resource list as input. |
| Dynamic `import(moduleName)` to reconstruct deleted resources | Replace with a `ResourceRegistry` that maps `type` strings to resource classes. |
| Hardcoded `console.log` throughout | Replace with an event emitter or pluggable logger. |
| Hardcoded not-found error names in `operation.delete.ts` | Use the resource own `notFoundOnError` matcher. |
| `State` class import from `provisioner/state.ts` | Replaced by the `@notation/state` interface. |

## API surface

```ts
import { Reconciler } from "@notation/reconciler";
import { FileStateBackend } from "@notation/state";

const reconciler = new Reconciler({
  state: new FileStateBackend("./.mystate/state.json"),
  logger: console,
  driftDetection: true,
  dryRun: false,
});

await reconciler.deploy(resources);
await reconciler.destroy(resources);
await reconciler.refresh(resources);
```

### The reconciliation algorithm (deploy)

```
for each resource in resources:
  1. no state?           -> CREATE, read-after-create, save state
  2. has state, params changed? -> UPDATE, read-after-update, save state
  3. has state, params same, drift detection on?
     a. read live resource
     b. live resource gone? -> re-CREATE
     c. live resource drifted? -> UPDATE to revert

for each state entry NOT in resources:
  -> resolve resource class from registry
  -> DELETE, remove from state
```

### Resource registry (for orphan reconstruction)

```ts
const registry = new ResourceRegistry();
registry.register(LambdaFunction);
registry.register(IamRole);

const reconciler = new Reconciler({ state: backend, registry });
```

### Events / observability

```ts
reconciler.on("operation", (event) => {
  // event: { action, resourceId, status, error? }
});
reconciler.on("drift", (event) => {
  // event: { resourceId, diff }
});
```

## Key design decisions

1. **Resources as input, not side-effect-loaded.** `reconciler.deploy(resources: BaseResource[])` — the caller provides the array.
2. **Replace dynamic `import(moduleName)` with a ResourceRegistry.**
3. **Fix not-found handling in delete.** Use the resource `notFoundOnError` matchers.
4. **Replace console.log with structured events.**
5. **Keep `deep-object-diff` as the diffing engine.**
6. **Boundary with resource:** The reconciler consumes `BaseResource`. Clean consume-only dependency.
7. **Boundary with state:** Depends on `StateBackend` interface, not implementation.
8. **Configurable retry:** `{ maxAttempts: 5, initialBackoffMs: 1000, backoffMultiplier: 1.5 }`

## Dependencies

| Dependency | Type |
|---|---|
| `@notation/resource` | inter-package (`BaseResource` interface) |
| `@notation/state` | inter-package (`StateBackend` interface, `StateNode` type) |
| `deep-object-diff` | external (diffing for drift detection) |

## Rough scope

~720 lines total. Main complexity is in the deploy workflow — the six-step reconciliation algorithm with drift detection.