---
type: epic
title: "@notation/resource"
created: "2026-02-26T00:54:17.966Z"
updated: "2026-02-26T00:54:17.966Z"
tasks:
  - TASK-001
  - TASK-002
  - TASK-003
priority: high
estimate: large
---
## Typed schema-driven definitions for stateful external resources.

## Why

Terraform resources are procedural code. You write imperative `create`, `read`, `update`, `delete` handlers scattered across files, then wire them together with HCL glue. The resource definition and its behavior are separate concerns in separate languages. Pulumi improves on this with real programming languages but the resource model is still imperative — you describe *how* to provision, not *what* a resource is.

`@notation/resource` is a **declarative resource model**. A single schema definition captures everything about a resource: its shape (via Zod), which fields are params vs computed, which are keys, which are immutable, which are volatile. The CRUD operations are typed against this schema — the types *derive* from the declaration. The schema is the source of truth, and everything else — diffing, state projection, key extraction, parameter resolution — is computed from it automatically.

This matters because:

1. **A reconciler can be generic.** If every resource has the same declarative shape, the reconciliation engine does not need to know about specific resources. It just walks the schema. This is what makes `@notation/reconciler` possible as a separate package.
2. **Resources become data, not code.** A schema-driven resource can be serialized, compared, diffed, and reasoned about without executing it. This is the foundation for drift detection, plan previews, and conformance checking.
3. **Agents can write resources.** A declarative schema is far easier for an AI agent to produce correctly than imperative CRUD code. The schema constrains the solution space.

### Known issue: type complexity

The current generic types (`SchemaFromApi`, `Params<S>`, `CompoundKey<S>`, etc.) are powerful but horrifically slow to compile. TypeScript type checker chokes on deeply mapped conditional types over schema objects. This needs an **intermediate materialization step** — the schema should be defined as a plain object, then a build step (or helper function) materializes the derived types into a concrete interface, rather than forcing TypeScript to re-derive them on every use. This is an architectural change the implementing agent should plan for, not necessarily solve in v1, but the API should be designed to allow it.

---

## What to extract

### Core types and classes

| Source file | What to take |
|---|---|
| `orchestrator/resource.schema.ts` | `Schema`, `SchemaItem`, `Params`, `CompoundKey`, `ComputedPrimaryKey`, `Result`, `Output`, `State` types, `SchemaFromApi`, `MapSchema`, and all supporting utility types |
| `orchestrator/resource.ts` | `BaseResource` interface, `Resource` abstract class, `resource()` builder function, `ErrorMatcher`, `ResultCondition`, `ResultConditions` types |
| `orchestrator/resource-group.ts` | `ResourceGroup` class (but see changes below) |
| `utils/types.ts` | `OptionalIfAllPropertiesOptional`, `Fallback`, `FallbackIf`, `NoInfer` — the subset actually used by the resource layer |

## What to leave behind

| Thing | Why |
|---|---|
| `orchestrator/state.ts` (module-level `resources`/`resourceGroups` arrays, `reset()`, counter) | Global mutable singletons. ResourceGroup should accept a registry via constructor, or callers manage their own arrays. |
| `orchestrator/graph.ts` (`getResourceGraph`) | Notation-specific: loads a compiled JS entry point via import side effects. |
| `orchestrator/state-getters.ts` | Thin wrappers over the global singletons — gone with them. |
| `resource.meta` naming convention | The `meta` getter hardcodes `@notation/` prefix and `.iac` suffix. Drop `meta` entirely; the `type` string is the only identifier. |
| `setIntrinsicConfig` naming | Rename to `deriveParams` or `resolve`. |

## API surface

```ts
import { defineResource, Schema } from "@notation/resource";
import { z } from "zod";

const DnsRecord = defineResource({ type: "dns/zone/Record" })
  .schema({
    name:    { valueType: z.string(), propertyType: "param",    presence: "required", primaryKey: true },
    type:    { valueType: z.string(), propertyType: "param",    presence: "required", immutable: true },
    value:   { valueType: z.string(), propertyType: "param",    presence: "required" },
    ttl:     { valueType: z.number(), propertyType: "param",    presence: "optional" },
    zoneId:  { valueType: z.string(), propertyType: "computed", presence: "required" },
  } as const)
  .operations({
    create: async (params) => { /* call provider API, return computed keys */ },
    read:   async (key)    => { /* read from provider, return result */ },
    update: async (key, patch, params, state) => { /* update provider */ },
    delete: async (key, state) => { /* delete from provider */ },
  });

const myRecord = new DnsRecord({
  id: "my-app-dns",
  config: { name: "app.example.com", type: "A", value: "1.2.3.4", ttl: 300 },
});
```

### Dependencies between resources

```ts
const AppRecord = DnsRecord
  .requireDependencies<{ zone: InstanceType<typeof Zone> }>()
  .deriveParams(({ deps }) => ({
    value: deps.zone.output.nameservers[0],
  }));
```

## Key design decisions

1. **Remove global mutable state.** ResourceGroup manages its own `resources` array. Remove all interaction with global arrays.
2. **Decouple `meta` from Notation module naming convention.** Drop `meta` entirely. Use `type` string as the only identifier.
3. **Rename `setIntrinsicConfig` to `deriveParams`.**
4. **`SchemaFromApi` — keep as opt-in power feature.**
5. **Zod as the only validation library.** Hard dependency on Zod. Keep it.
6. **Boundary with reconciler:** `BaseResource` defines the CRUD contract. The reconciler consumes this interface. `@notation/resource` defines WHAT, `@notation/reconciler` executes it.
7. **Boundary with state:** No dependency on state. `State<S>` in `resource.schema.ts` is a type-level projection, not the persistence class.

## Dependencies

| Dependency | Type | Notes |
|---|---|---|
| `zod` | external, peer | Schema `valueType` is `z.ZodType<T>`. Peer dep. |

**No inter-package dependencies.** This package is the leaf.

## Rough scope

~590 lines total. Most work is untangling global state and renaming. The type-level code is already clean and portable.