# Recovery

The reconciler prevents orphaned cloud resources, duplicated creates, and broken dependency chains across process crashes, ambiguous responses, interrupted replacements, and teardowns.

## Creating Records

Before invoking `resource.create`, `createResourceOperation` (`packages/reconciler/src/operations/operation.create.ts`) persists an intermediate `"creating"` state record. Subsequent runs use it to detect started attempts and reuse generated physical names.

### Record Persistence

`creatingRecord(params)` writes `lastOperation: "creating"` under `state:persist:<id>:creating`:

- **Recorded fields** – Stores `id`, `group`, `type`, `provider`, `lastOperationAt`, resolved `config`, `params` (with generated `physicalName` values), `dependsOn`, and `retired`. `output` stores `resource.toState(definedKey(resource, resourceParams))` for any key fields already in `params`.
- **Name preservation** – `recordedNames` reads `physicalName` fields from `"creating"` records just like completed records. Retries and subsequent deploys attempt creation and lookup under the same generated name.
- **Planner and output isolation** – `decideAction` treats `isCreatingRecord(stateNode)` as `"create"` and sets `PlanNode.mayTakeOver = true`. `loadOutput` and `readRecordedOutputs` suppress its `output` so dependents plan against unknown values.

### Deleting Unfinished Creates

When `deleteResourceOperation` (`packages/reconciler/src/operations/operation.delete.ts`) deletes a `"creating"` record (`params.creatingParams` is set), `findCreatedResource` inspects the provider before calling `resource.delete`:

| Condition | Behavior |
| :--- | :--- |
| Missing find match | Skips remote delete with `reason: "not-created"` and removes record |
| Undefined key field | Skips remote delete with `reason: "key-unknown"` and removes record |
| Defined key fields | Runs `delete` with `resource.key`, treating `ResourceNotFoundError` as deleted |

When `resource.find` exists, it runs under `delete:find` with `creatingParams` and skips on a `null` match; otherwise `findCreatedResource` checks whether any `resource.key` field is `undefined`. Skipped remote deletes emit `status: "skip"`.

## Unknown Create Outcomes

Each create attempt inside `retryPending` runs through `@notation/durable`'s `step.effect` so a crash or indeterminate failure never blindly invokes `create` a second time.

### Durable Effect Execution

`createAttempt` executes `step.effect("create:remote:effect:<attempt>", ...)` with these constants from `packages/reconciler/src/operations/operation.create.ts`:

- **`CREATE_LOOKUP_RETRY_MS = 1_000`** – Durable delay (`retryIn`) between unknown-outcome lookups.
- **`MAX_CREATE_LOOKUP_ATTEMPTS = 10`** – Upper cap on lookup retries (`Math.min(params.maxOperationAttempts ?? DEFAULT_MAX_OPERATION_ATTEMPTS, MAX_CREATE_LOOKUP_ATTEMPTS)`).
- **`failsOn` predicate** – Treats errors as terminal for the effect when `lookup === undefined || !ResourceCreationUnknownError.is(error)`. `ResourceAlreadyExistsError` routes to takeover, while `ResourceOperationPendingError` advances `retryPending` with a new `effectId` and `callbackContext`.
- **Credential stripping** – `perform` calls `holdCreated(resource, ...)` to extract and hold credentials in memory. Only `key`, credential versions, and `invalid` names are journaled in the effect result.

### Effect Lookup Functions

`getLookupFunction(resource, resourceParams)` selects how `step.effect` probes the provider after an indeterminate attempt:

| Capability | Behavior |
| :--- | :--- |
| Find operation | Calls `findResourceKey` and settles or returns `not-found` |
| Read without computed key | Calls `read` and treats `ResourceNotFoundError` as `not-found` |
| No lookup operation | Returns `undefined` and keeps the `"creating"` record |

For `resource.find`, a match returns `{ status: "settled", result: { key, lookedUp: true } }` and `null` returns `{ status: "not-found" }`. For `resource.read`, success or a non-throttled `ResourceOperationPendingError` returns `settled()`, while other errors – including `error.throttled` – rethrow so the effect retries later. When no lookup is available, the `"creating"` record stays in state on `ResourceCreationUnknownError` or `EFFECT_OUTCOME_UNKNOWN`.

## Resource Takeovers

When an existing resource matches the target identity, `takeOver` adopts it into state and delegates to `reconcileTakenOver` (`packages/reconciler/src/durable/reconcile.ts`).

### Takeover Paths

`createResourceOperation` enters `takeOver(step, params, key)` through three paths:

| Path | Trigger |
| :--- | :--- |
| Pre-create find | `create:find` locates an existing match before writing `"creating"` |
| Effect lookup settlement | `getLookupFunction` settles an indeterminate create with `created.lookedUp === true` |
| Already-exists error | `createAttempt` throws `ResourceAlreadyExistsError` and `existingKey` resolves the key |

Pre-create `find` covers missing records, `"creating"` records, and `drift-recreate`. On `ResourceAlreadyExistsError`, `existingKey` resolves the key via `find` under `create:existing` or returns `{}` when `params` holds the entire primary key.

### Observed Parameter Mapping

`takeOver` reads the remote resource under `create:takeover` (`readRemoteOperation`) and calls `setRecordedOutput(resource, { ...key, ...output })`. Credentials receive `null`-version markers because existing secrets cannot be read. It then persists a `"create"` record under `state:persist:<id>:taken-over` using `observedParams(resource, remote ?? {}, resourceParams)`:

```ts [packages/reconciler/src/operations/operation.create.ts]
const unread = Object.fromEntries(
  set.filter(([name]) => remote[name] === undefined),
);
const { changed, replaceFields } = diffParams(resource.schema, {}, unread, {
  canUpdate: Boolean(resource.update),
});
const kept = new Set(replaceFields.map((field) => field.name));
const leftOut = new Set(changed.filter((name) => !kept.has(name)));
```

Mutable params omitted by `remote` are left out of the persisted record so the next comparison updates them. Unread `immutable`, key, or non-updatable params keep their desired values so missing read fields never trigger a spurious replacement.

### Post-Takeover Reconciliation

When `createResourceOperation` returns `{ tookOver: true }`, `applyAction` calls `reconcileTakenOver(step, opts, shared, replaceWithout)`:

- **Fresh state session** – Opens a new `openStateSession` under scope `taken-over` with `stateKey` `:after-takeover`. This prevents collisions with `state:persist:<id>:taken-over`.
- **No repeat drift read** – Runs `decideAction` directly against the newly read record and emits `reconciler.deploy.decision`. It then invokes `applyAction` with `executionId: "${shared.executionId}/taken-over"`.

## Takeover Guards

Two safety guards prevent a takeover from corrupting replacements or adopting the wrong remote resource.

### Replacement Key Guard

During a delete-first replacement (`params.replaces` is set), `refuseReplaced(params, key)` compares `resource.keyOf({ ...resourceParams, ...key })` against `resource.keyOf(replaces.output)` across all three takeover paths:

- **Identical key refusal** – If `changedKeys` is empty, the existing resource may be the replaced instance still lingering in provider listings. `refuseReplaced` restores `params.replaces` via `restoreRecord` and throws `ResourceAlreadyExistsError` so the next deploy deletes and recreates cleanly.
- **Scope limit** – `refuseReplaced` runs only inside the immediate delete-first replacement. Later deploys resuming from `"creating"` records, or `blocksDeleteOf` dependents recreated later in the same run, have `params.replaces === undefined`.

### Uniqueness Guard

When `create` throws `ResourceAlreadyExistsError`, `existingKey(step, params, error)` prevents ambiguous adoption:

- **Computed primary keys** – If `hasComputedPrimaryKey(resource)` is true and `resource.find` is absent, `existingKey` throws `ResourceAlreadyExistsError` noting the provider-assigned key.
- **Empty or multi-match `find`** – If `find` returns `null`, `existingKey` throws `ResourceAlreadyExistsError`. Provider `find` helpers (such as `findOnlyInPages`) must fail whenever multiple remote resources match.

### Readability Requirement

`refuseUnreadable` and `takeOver` enforce that `resource.read` is implemented before adopting an existing resource. Without `read`, `noReadError` throws and instructs the operator to delete the remote resource manually.

## Failed Create Recovery

After a create error, `createResourceOperation` either leaves the `"creating"` record intact for recovery or rolls state back to its starting snapshot.

### Record Restoration

`restoreRecord(params, record = params.prior)` writes under `state:persist:<id>:restored`:

| Outcome | State |
| :--- | :--- |
| Unknown outcome or failed read | Keeps the `"creating"` record intact for recovery |
| Replacement takeover guard failure | Restores `params.replaces ?? params.prior` so the next deploy replaces |
| Other create failure | Restores `params.prior` or clears the `"creating"` record to `null` |

`restoreRecord` preserves `retired: record.retired ?? []` when writing a record, or writes `null` if `record` is `undefined`. Unknown outcomes match `isOutcomeUnknown(error)` (`ResourceCreationUnknownError` or `WorkflowEffectError` with `code === "EFFECT_OUTCOME_UNKNOWN"`), and replacement takeover guard failures occur in `existingKey`, `refuseReplaced`, or `refuseUnreadable`.

### Deferred Validation Checks

Some provider APIs apply changes asynchronously before their read endpoint reflects them, or return incomplete metadata after succeeding. `createResourceOperation` and `updateResourceOperation` handle both via `readLagsCreate` and `firstDeferredError` (`packages/reconciler/src/operations/deferred-checks.ts`):

- **`readLagsCreate` 2s retry** – When `resource.readLagsCreate` is set, `createResourceOperation` passes `{ retryNotFoundMs: 2_000 }` (`READ_AFTER_CREATE_RETRY_MS`) to `readResourceOperation`. This converts `ResourceNotFoundError` into `ResourceOperationPendingError` while preserving `callbackContext`.
- **Deferred error persistence** – `firstDeferredError` checks credential validity/presence, `assertComputedFields`, `readResourceOperation`, and `assertRequiredOutputs` in order, capturing the first `ValueValidationError` or `SchemaStructureError`. The caller persists `"create"` or `"update"` before throwing so state tracks the live resource; any other error throws immediately (`updateResourceOperation` restores `{ ...params.persistedOutput, ...params.resource.output }` if the read fails).

## Replacement Strategies

`packages/reconciler/src/durable/reconcile.ts` executes either `replaceCreateFirst` or `replaceDeleteFirst` based on `replaceOrder(resource)`.

### Create-First Replacement

`replaceCreateFirst` runs under scope `replace:create`:

1. **Generate new names** – Calls `generateNamesStep` (`replace:create:physical-names`).
2. **Retire prior instance** – Captures `retiredAt` in `replace:create:retired-at` and appends `retiredInstance(session.node, shared.dependsOn, retiredAt)` to `session.node.retired ?? []`.
3. **Create beside old resource** – Calls `createResourceOperation` with `retired` so `"creating"` and `"create"` writes carry the retired list atomically. In `dryRun`, emits a `delete` `dry-run` event with `reason: "retired"`.
4. **Post-takeover handling** – Calls `reconcileTakenOver` if `tookOver` is true, leaving retired instances for `sweepOrphans` at the end of `deploy`.

### Retired Instance Cleanup

`deleteRetiredInstances` (`packages/reconciler/src/durable/reconcile.ts`) iterates `node.retired ?? []` oldest first (`index = 0, 1, ...`) under `step.scope("retired:<index>")`:

- **Per-instance slicing** – After `deleteResourceOperation` deletes instance `index` (passing `readRetiredDeletion` if `deleteTakesDependents` is set), its `remove` callback calls `session.persist({ ...toPersistedState(node, node.dependsOn!), retired: instances.slice(index + 1) }, "retired:<index>")`.
- **Error attribution** – State-write errors (`writing === true`, such as `VersionConflict`), `InfrastructureError`, and `WorkflowCancelledError` rethrow as-is. Provider delete refusals throw `retiredDeleteError`, naming dependent resources declared in code during `"deploy"`.

### Delete-First Replacement

`replaceDeleteFirst` runs in four phases:

1. **`deleteBlockingDependents`** – Under `replace:dependents`, skips `opts.state.values()` unless a registered class lists `resource.type` in `blocksDeleteOf`. Otherwise it collects transitive blocking dependents via `collectDependents`, checks `assertOrphanDeleteAllowed` and `rejectChange(..., { replace: true })` (respecting `findReplaceOverride`), and deletes each under `stateKey` `replace:<encodedResourceId>` with `reason: "dependency-replaced"` and `replacedDependency: resource.id`.
2. **Retired and active deletion** – Under `replace:delete`, calls `deleteRetiredInstances`, reads `readDeletion` (`dependents` step) if `deleteTakesDependents` is set, and runs `deleteResourceOperation` removing the store entry.
3. **Cycle contribution filtering** – If `replaceWithout?.(new Set(deleted))` returns non-empty cycle peers, `withoutContributions` re-evaluates `getParams` under `replace:params` without those contributions.
4. **Fresh session create** – Opens a new `openStateSession` under `replace:create` because the prior store instance was deleted. Calls `createResourceOperation` with `prior: undefined` and `replaces: { ...session.node, retired: [] }`.

## Output Backfill

When a resource decides `noop` despite an incomplete or stale state record, `applyAction` repairs state without calling `update` at the provider.

### Missing Required Outputs

`applyAction` checks `findMissingOutputs(resource, session.node.output)` on `noop` resources. If it catches `SchemaStructureError` (for instance after a post-operation validation failure), `recoverOutputs` (`packages/reconciler/src/durable/reconcile.ts`) runs `readResourceOperation` under `output-read`.

`recoverOutputs` merges `{ ...session.node.output, ...readResult }`, persists the record when `!opts.dryRun`, and rethrows if any required output remains absent. Resources without `read` fail earlier in `assertOutputsRecoverable`.

### Metadata Rewrites

When a `noop` resource has all required outputs and `!opts.dryRun`, `applyAction` checks `!hasSameEdges(session.node, dependsOn)`, `recorded.provider !== resource.provider`, and `!sameGroup(recorded.group, resource.group)`. If any differ, `rewriteRecord` (`packages/reconciler/src/durable/reconcile.ts`) updates state metadata without invoking provider operations.

## Destroy Traversal

`destroy` (`packages/reconciler/src/durable/destroy.ts`) acquires the deployment hold, lists state once under `notation:orphans:list`, and deletes every registered record in reverse dependency order.

### Edge Merging

For every declared resource in `opts.resources`, `destroy` merges three edge sets into `edgesById`:

| Source | Edges |
| :--- | :--- |
| Code graph | `getDependencyIds(resource)` |
| State record | `recordById.get(resource.id)?.dependsOn ?? []` |
| Retired instances | `retired[].dependsOn` from `sweptRecords` |

Merging retired edges ensures dependents left behind by an interrupted deploy are deleted before the retired instances they still reference.

### Unregistered Record Retention

Before deleting anything, `destroy` identifies records whose type has no class in `workflowRegistry(opts)`:

- **Type-mismatched declared records** – If `resource.type !== node.type` and `resolveRecordClass(registry, node)` is `undefined`, `keep(node, edgesById, kept)` marks the record and all transitive dependencies (including desired resources) in `kept`. It also emits `reconciler.orphan-deletion.skipped` with `workflow: "destroy"`.
- **Unregistered orphans** – `sweepSteps` runs `keep` on unregistered orphans and emits `reconciler.orphan-deletion.skipped` for each. Records whose `node.type` has a registered class still delete via `instantiateRecord`, even when `node.type !== declared.type`.

### Reverse Visit Order

`destroy` constructs a base order from registered orphans in `sweepSteps` order followed by `orderDeployUnits(opts.resources).reverse()` with each unit's `members` reversed.

It builds `dependentsById` while skipping intra-unit edges (`unitOfId(dependent) === unitOfId(id)`) so cycles tear down in exact reverse deploy order. A recursive walk visits unvisited `dependentsById` before deleting each target, breaking cross-unit loops by deleting the first-visited base-order record last:

- **Declared resources** – Deleted under `notation:destroy:<encodedId>`.
- **Orphans** – Instantiated from state via `instantiateRecord` and deleted under `notation:orphans:<encodedId>`.
