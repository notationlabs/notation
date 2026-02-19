---
type: epic
title: "@notation/state"
created: "2026-02-26T00:55:21.617Z"
updated: "2026-02-26T00:55:21.617Z"
tasks:
  - TASK-007
  - TASK-008
priority: high
estimate: small
---
## Pluggable state backend with diff and drift detection.

## Why

State is what makes a reconciler stateful. Without it, every deploy is a full create — you cannot diff, you cannot detect drift, you cannot clean up orphans. But state backends are always hardcoded into the tools that use them: Terraform state lives in Terraform, Pulumi state lives in Pulumi, and switching backends means adopting their entire ecosystem.

`@notation/state` is a tiny interface — five methods — that decouples state storage from everything else. The reconciler does not care if state lives in a JSON file, DynamoDB, S3, SQLite, or in-memory. This means:

1. **Test without infrastructure.** `MemoryStateBackend` lets you unit test reconciliation workflows without touching the filesystem. Fast, deterministic, no cleanup.
2. **Production-grade state without lock-in.** Implement `StateBackend` against your existing infrastructure. State lives where your data lives — not in a vendor cloud.
3. **The smallest useful package.** At ~250 lines, this is the foundation that makes the rest composable. It is a leaf dependency with zero external packages.

---

## What to extract

| Source file | What to take |
|---|---|
| `provisioner/state.ts` | `StateNode` type, `State` class -> refactor into interface + file-based implementation |

## What to leave behind

| Thing | Why |
|---|---|
| `Resource["meta"]` reference in `StateNode` type | Replace `meta: { moduleName, serviceName, resourceName }` with just `type: string` |
| Hardcoded `.notation/state.json` path | Move to constructor parameter |
| `fs-extra` | Replace with Node built-in `fs/promises` |
| `groupId` and `groupType` on `StateNode` | Keep as extensible fields via index signature, not first-class |

## API surface

### StateBackend interface

```ts
interface StateBackend {
  get(id: string): Promise<StateNode | undefined>;
  has(id: string): Promise<boolean>;
  update(id: string, patch: Partial<StateNode>): Promise<void>;
  delete(id: string): Promise<void>;
  values(): Promise<StateNode[]>;
}
```

### StateNode type

```ts
type StateNode = {
  id: string;
  type: string;                          // e.g. "aws/lambda/LambdaFunction"
  config: Record<string, unknown>;
  params: Record<string, unknown>;
  output: Record<string, unknown>;
  lastOperation: "create" | "update" | "delete" | "drift";
  lastOperationAt: string;               // ISO 8601
  [key: string]: unknown;                // extensible
};
```

### Implementations

- `FileStateBackend` — built-in, uses `node:fs/promises`, atomic writes (write-to-temp-then-rename)
- `MemoryStateBackend` — for testing
- Custom: implement `StateBackend` interface

## Key design decisions

1. **Interface-first design.** Primary export is `StateBackend` interface.
2. **Read-per-operation for FileStateBackend.** Correctness over performance.
3. **Atomic writes.** Write to temp file then `rename()`. Prevents corruption.
4. **Drop `fs-extra`.** Use `node:fs/promises` directly. Zero external dependencies.
5. **Flatten `meta` into `type`.** Single string, no Notation naming conventions.
6. **Extensible StateNode.** Index signature for reconciler-specific metadata.
7. **No dependency on `@notation/resource`.** This package is a leaf.

## Dependencies

Zero external dependencies. Uses only `node:fs/promises` and `node:path`.

No inter-package dependencies. Leaf package alongside `@notation/resource`.

## Rough scope

~250 lines total. Smallest of the three core packages.

## Dependency graph

```
@notation/resource          @notation/state
      |                          |
      v                          v
           @notation/reconciler
```