# Plan Schema

`notation plan --json`, `planApp`, and `createPlan` return a `Plan` object describing every planned resource action in execution order.

## Core types

`Plan`, `PlanNode`, and `PlanDecision` are exported from `@notation/reconciler` and `@notation/core`:

```ts [TypeScript]
export type Plan = {
  createdAt: string;
  nodes: PlanNode[];
};

export type PlanDecision =
  | "create"
  | "update"
  | "replace"
  | "drift-update"
  | "drift-replace"
  | "drift-recreate"
  | "delete-orphan"
  | "delete-retired"
  | "noop";

export type ReplaceOrder = "create-first" | "delete-first";

export type ParamReplaceField = {
  name: string;
  known: boolean;
  requested?: never;
};

export type ReplaceField =
  | ParamReplaceField
  | { requested: true; known: true; name?: never };

export type PlanDiff = {
  added: Record<string, unknown>;
  deleted: Record<string, unknown>;
  updated: Record<string, unknown>;
};

export type PlanNode = {
  id: string;
  type: string;
  decision: PlanDecision;
  diff?: PlanDiff;
  replaceFields?: ReplaceField[];
  replaceOrder?: ReplaceOrder;
  retiredAt?: string;
  retiredIndex?: number;
  replacedDependency?: string;
  brokenDependents?: string[];
  rotates?: string[];
  cycle?: string[];
  placeholder?: true;
  mayTakeOver?: true;
  instanceHash?: string;
  params: Record<string, unknown>;
  dependsOn: string[];
};
```

`Plan.createdAt` is an ISO-8601 timestamp, and `Plan.nodes` lists planned actions in reconciliation order:

- **Deployment units** – Declared resources appear in topological unit order, with `delete-retired` nodes placed immediately before any `delete-first` replacement of the same resource.
- **Sweep nodes** – Remaining `delete-retired` instances and `delete-orphan` records appear at the end in deletion sweep order, followed by any unregistered orphans kept by the sweep.

## Plan decisions

Every `PlanNode` carries one of nine `PlanDecision` values:

| Decision | Description |
| :--- | :--- |
| `create` | Resource has no completed state record |
| `update` | Desired parameters differ from persisted state on mutable fields only |
| `replace` | Immutable change, missing `update`, `--replace`, or cascade forces recreation |
| `drift-update` | Desired parameters match state, but remote `read` returned drifted mutable fields |
| `drift-replace` | Desired parameters match state, but remote `read` detected drift on a replacement-forcing field |
| `drift-recreate` | State holds a record, but remote `read` threw `ResourceNotFoundError` |
| `delete-orphan` | Recorded resource is no longer declared in code |
| `delete-retired` | Superseded instance retired by an earlier `create-first` replacement awaiting deletion |
| `noop` | Desired parameters and remote state match |

When `create` applies to an unfinished `"creating"` record, the node sets `mayTakeOver: true`. `keepsResource(decision)` (`@notation/reconciler`) returns `true` for `"noop"`, `"update"`, and `"drift-update"`, indicating that the existing resource instance and its credentials remain in place.

## Plan node fields

Optional fields are omitted from JSON output unless applicable to the node:

| Field | Description |
| :--- | :--- |
| `id` | Resource ID from code or persisted state |
| `type` | Resource type identifier such as `"aws/sqs/Queue"` |
| `decision` | Planned action for this node |
| `diff` | Added, deleted, and updated comparable parameters |
| `replaceFields` | Triggering fields on `replace` and `drift-replace` nodes |
| `replaceOrder` | Replacement ordering on `replace` and `drift-replace` |
| `retiredAt` | ISO-8601 timestamp when a `create-first` replacement retired this instance |
| `retiredIndex` | Zero-based index in the record's `retired` array, ordered oldest first |
| `replacedDependency` | Upstream dependency ID forcing a `delete-first` cascade onto this dependent |
| `brokenDependents` | Sorted IDs of declared dependents left in place by `deleteTakesDependents` |
| `rotates` | Credential names receiving new values on a kept resource |
| `cycle` | IDs of all other members in the same dependency cycle |
| `placeholder` | Marks a cycle placeholder created before cross-cycle contributions |
| `mayTakeOver` | Marks `create` when an unfinished `"creating"` record exists |
| `instanceHash` | 8-character lowercase hex hash for declared resources with a completed record |
| `params` | Resolved parameters with post-apply unknowns marked as `{ "$unknown": "after-apply" }` |
| `dependsOn` | Sorted, deduplicated dependency IDs |

Field rules and defaults:

- **`id`** – Shares the owning resource's ID for `delete-retired` nodes.
- **`diff`** – Normalizes `undefined` leaf values to `null`; present on `update`, `replace`, `drift-update`, `drift-replace`, and credential source `update`, and omitted on cascade-only `replace`.
- **`replaceFields`** – Omitted on cascade-only replacements. Parameter-triggered entries carry `{ name, known }`, and `--replace` entries carry `{ requested: true, known: true }`.
- **`replaceOrder`** – Defaults to `"create-first"` when the resource has a `physicalName` param or `replaceCreatesFirst: true`, and `"delete-first"` otherwise or when forced by `replacedDependency`.
- **`retiredAt` and `retiredIndex`** – Present only on `delete-retired` nodes.
- **`instanceHash`** – Absent on `"creating"` records, orphans, and retired instances.
- **`params`** – Holds persisted parameters on `delete-orphan` and `delete-retired` nodes.

## Post-apply unknowns

Values known only after upstream operations finish appear in `params`, `diff`, and `patch` at their exact path as `UNKNOWN_AFTER_APPLY`:

```ts [TypeScript]
export const UNKNOWN_AFTER_APPLY = { $unknown: "after-apply" } as const;
export type UnknownAfterApply = typeof UNKNOWN_AFTER_APPLY;
```

Three sources produce `{ "$unknown": "after-apply" }` during planning:

- **Uncreated or replaced dependencies** – `OutputRef` and `Derived` values pointing to a dependency being created, replaced, or lacking a required output in state.
- **Generated physical names** – Every `physicalName` parameter on a resource being created or replaced.
- **Rotated or passed credentials** – Credential outputs on kept resources listed in `rotates`.

When `{ "$unknown": "after-apply" }` appears inside a replacement-forcing parameter, `replaceFields` sets `known: false` because replacement depends on the resolved runtime value. When a credential source's parameters contain `{ "$unknown": "after-apply" }`, the planner skips `read` and plans `create` (no record) or `update` (existing record).

## Cascade constraints

Only `delete-first` replacements cascade to dependents (`create-first` replacements retire the previous instance without deleting dependents first):

- **Blocking relationship** – A dependent record cascades only if its resource class lists the dependency's `type` in `blocksDeleteOf` (credential sources never block deletion).
- **Forced order** – Cascaded dependents are forced to `decision: "replace"` and `replaceOrder: "delete-first"`, overriding `physicalName` or `replaceCreatesFirst`, and `rejectChange` is evaluated with `{ replace: true }`.
- **Broken references** – If the replaced resource sets `deleteTakesDependents` and leaves non-cascaded declared dependents in place, their IDs are recorded in `brokenDependents`.

## Cycle placeholder constraints

When resources form a strongly connected dependency cycle, the planner breaks loops greedily in input order by marking placeholder members (`placeholder: true` on `create` or `drift-recreate` nodes). A resource can serve as a cycle placeholder only if it satisfies all three constraints:

- **Contribution-only loop edges** – At least one edge to the remaining loop comes strictly from contributions, not from `config`, `dependencies`, or `dependOn`.
- **Updatable class** – The resource class implements `update` so a subsequent pass can apply the omitted cross-cycle contributions.
- **Optional non-replacing targets** – Every parameter set by contributions referencing cycle peers is optional (`presence !== "required"`) and does not force replacement (`immutable`, `primaryKey`, `secondaryKey`).

If no member of a cycle loop satisfies all three conditions, planning fails with `ResourceCycleError`. See [Planner](../internals/planner.md).
