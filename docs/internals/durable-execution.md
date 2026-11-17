# Durable Execution

The `@notation/reconciler/durable` driver expresses `deploy` and `destroy` as `@notation/durable` async-generator workflows. Notation owns desired-state decisions, cycle convergence, and provider lifecycles, while the durable runtime owns step journaling, non-blocking delays, and atomic store state.

## Workflow Architecture

Both `deploy` (`packages/reconciler/src/durable/deploy.ts`) and `destroy` (`packages/reconciler/src/durable/destroy.ts`) accept a `DurableStep` primitive and a `DurableStateBackend` (`packages/reconciler/src/durable/state-backend.ts`) tied to a `deploymentId` (`<app>:<stage>`).

### Pre-flight Steps

Before acquiring the deployment hold, `deploy` runs two checks:

- **Dependency presence** – `assertDependenciesPresent(opts.resources)` verifies that every dependency is in the deployment or already has an output.
- **Cached validation** – `step.run("notation:validate", ...)` runs `checkOverrides` and `validateKnownParams` once. Resumed runs skip re-running `deriveParams`, re-checking `rejectChange` or `assertOrphanDeleteAllowed`, and re-collecting `UnobtainableCredentialError`.

Inside `withDeploymentHold`, `deploy` re-checks `opts.overrides` under `notation:overrides` against any prior holder's state. It snapshots `~state` targets once under `notation:recorded-outputs` via `readRecordedOutputs`, walks `orderDeployUnits(opts.resources)` (`reconcileCycle` or `reconcileResource`), and finishes with `sweepOrphans`.

### Durable Stores

`packages/reconciler/src/durable/stores.ts` defines two Valibot-backed stores prefixed with `notation/` so they never collide with application stores on a shared `StoreClient`:

- **`notation/resource-state`** – `resourceStateStore`, initialized to `null` per `${encodeURIComponent(deploymentId)}:${resourceId}`. Both the record and `retired[]` entries use `v.objectWithRest` so driver fields survive reads and writes.
- **`notation/deployment-hold`** – `deploymentHoldStore`, initialized to `{ holder: null }` per `deploymentId`.

### Conditional State Sessions

`openStateSession` (`packages/reconciler/src/durable/reconcile.ts`) reads `opts.state.snapshot(resource.id)` under `persisted-record`. It returns a `ResourceStateSession` whose `persist` and `remove` generators mutate `resourceStateStore` against a mutable `SnapshotRef`:

- **Compare-and-set writes** – `persist` calls `store.updateFrom` and `remove` calls `store.deleteFrom` against `ref.current` (`instanceId` + `version`). Each write updates `ref.current` and throws `VersionConflict` if `!result.updated` or `!result.deleted`.
- **Retired record preservation** – `persist` keeps `current.state?.retired` when `next.retired === undefined` and strips empty arrays via `withoutEmptyRetired`. `assertNoRetired` rejects any `null` write or `remove` while retired instances exist.

### Registered Error Classes

`packages/reconciler/src/durable/errors.ts` registers custom error constructors with `registerErrorClass` so `instanceof` checks survive journal replay across process restarts:

- **`VersionConflict`**
- **`ResourceOperationPendingError`**
- **`ResourceNotFoundError`**
- **`ResourceAlreadyExistsError`**
- **`ValueValidationError`**
- **`SchemaStructureError`**
- **`ResourceTypeChangedError`**
- **`ResourceCycleError`**

## Step Key Taxonomy

Every persisted step key and effect ID in `packages/reconciler/src/durable/index.ts` is part of the durable replay contract. Scopes URI-encode resource IDs so `:` delimiters stay unambiguous, while `state:` keys carry raw resource IDs because store handles outlive their opening scope.

### Workflow Step Keys

Top-level workflow steps use the `notation:` prefix:

| Key | Description |
| :--- | :--- |
| `notation:providers` | `@notation/core` provider package list |
| `notation:providers:<package>:emit` | Provider package load failure warning |
| `notation:validate` | Pre-hold overrides and known-param check |
| `notation:overrides` | Post-hold override re-validation |
| `notation:recorded-outputs` | Initial `~state` reference snapshot |
| `notation:hold:inspect` | Initial hold holder check |
| `notation:hold:acquire` | Exclusive hold take |
| `notation:hold:release` | Hold release on completion or failure |
| `notation:deploy:<id>:*` | Single-unit reconciliation scope |
| `notation:deploy:<id>:placeholder:*` | Cycle first-pass placeholder scope |
| `notation:deploy:<id>:settle:<n>:*` | Cycle settle pass `<n>` scope |
| `notation:destroy:<id>:*` | Declared resource destroy scope |
| `notation:orphans:list` | State list read for sweep or destroy |
| `notation:orphans:<id>:*` | Orphan delete scope |
| `notation:retired:<id>:*` | Retired instance sweep scope for code records |

### Operation Step Keys

Scoped operation steps execute inside the enclosing resource, cycle, or sweep scope:

| Key | Description |
| :--- | :--- |
| `*:persisted-record` | Initial snapshot read in `openStateSession` |
| `*:params` | Cached `getParams` evaluation |
| `*:physical-names` | Generated `physicalName` values |
| `*:drift-read:*` | Drift-check read scope |
| `*:output-read:*` | Post-noop missing-output read scope |
| `*:create:find` | Pre-create find lookup |
| `*:create:existing` | Existing key lookup after `ResourceAlreadyExistsError` |
| `*:create:remote:effect:<n>` | Single create attempt effect |
| `*:create:takeover:read:*` | Remote read during resource takeover |
| `*:taken-over:*` | Post-takeover decision and reconciliation |
| `*:remote:attempt:<n>` | Single read, update, or delete attempt |
| `*:remote:retry-delay:<n>` | Durable sleep between pending attempts |
| `*:delete:find` | Find lookup when deleting a `"creating"` record |
| `*:dependents` | State scan for `deleteTakesDependents` |
| `*:retired:<n>:*` | Delete of retired instance `<n>` |
| `*:replace:dependents:*` | Blocking dependent deletion cascade |
| `*:replace:delete:*` | Delete-first replacement deletion half |
| `*:replace:create:*` | Replacement create half |
| `*:replace:create:retired-at` | Timestamp when create-first replace retires old instance |
| `*:credentials:needed` | Check of producer credentials needing minting |
| `*:credential:<name>:rotate` | Proactive credential rotation |
| `*:credential-passed:<name>:passed` | `--credential` env value validation and version |
| `*:credentials:refresh:<versions>:*` | Post-resume refresh for un-received credentials |
| `*:source-read:read` | Credential source read and warnings |
| `*:emit:<event>[:<operation>:<status>]` | Event delivery checkpoint |

Retired instances under `*:retired:<n>:*` are deleted oldest first.

### State Write Keys

Conditional state writes use `state:` keys constructed by `stateKey` in `reconcile.ts`:

| Key | Description |
| :--- | :--- |
| `state:persist:<id>` | Conditional create or update |
| `state:persist:<id>:creating` | Pre-create `"creating"` record write |
| `state:persist:<id>:taken-over` | Post-takeover `"create"` record write |
| `state:persist:<id>:restored` | Restored record or `null` after failed create |
| `state:persist:<id>:retired:<n>` | Removal of retired instance `<n>` from `retired[]` |
| `state:persist:<id>:credential:<version>` | Recorded new credential version marker |
| `state:delete:<id>` | Conditional store deletion |
| `state:<write>:<id>[:<stage>]:settle:<n>` | Write during cycle settle pass `<n>` |
| `state:<write>:<id>[:<stage>]:after-takeover` | Write following a takeover |
| `state:<write>:<id>[:<stage>]:credentials:<v>` | Write during credential refresh |
| `state:delete:<id>:replace:<replaced id>` | Blocking dependent removal for `<replaced id>` |

Failed create restoration (`state:persist:<id>:restored`) writes `null` when no prior record existed, and `:after-takeover` suffixes nest per takeover.

### Create Effect IDs

Each create attempt runs via `step.effect` using a deterministic `effectId` formed by `createEffectId`:

```txt [Effect ID format]
notation:create:<encodedExecutionId>:<encodedResourceId>:<attempt>
```

If a create takes over an existing resource, `reconcileTakenOver` appends `/taken-over` to `shared.executionId` (`<executionId>/taken-over`). Recursive takeovers nest `/taken-over` so replacement creates in the same execution never collide on `effectId`.

## Scoped Execution

Reusable operations avoid step key collisions across call sites through `scopeStep` and `durableEmitter` (`packages/reconciler/src/durable/step.ts`).

### Step Scoping

`scopeStep(step, prefix, stateKey?)` wraps a `DurableStep` into a `DurableStepRunner`:

```ts [packages/reconciler/src/durable/step.ts]
export function scopeStep(
  step: DurableStep,
  prefix: string,
  stateKey?: string,
): DurableStepRunner {
  const scoped = (key: string) => `${prefix}:${key}`;

  return {
    run: (key, fn) => step.run(scoped(key), fn),
    effect: (key, descriptor) => step.effect(scoped(key), descriptor),
    delay: (key: string, ms: number) => step.delay(scoped(key), ms),
    store: step.store,
    stateKey,
    scope: (nested: string, nestedStateKey = stateKey) =>
      scopeStep(step, scoped(nested), nestedStateKey),
  };
}
```

Nested `scope()` calls prepend prefixes and inherit `stateKey` unless overridden. When `openStateSession` calls `persist` or `remove`, `stateKey()` appends `:${step.stateKey}` so writes across `settle:<n>`, `replace:<replaced id>`, and `after-takeover` stay distinct in the journal.

### Event Checkpointing

`durableEmitter(step, emit)` checkpoints every emitted `ReconcilerEvent` inside `step.run`:

- **Deterministic keys** – `reconciler.operation.lifecycle` uses `emit:reconciler.operation.lifecycle:<operation>:<status>`; all other events use `emit:<event>`. Enclosing scopes separate multiple operations.
- **Duplicate tolerance** – If a process crashes after `emit(event)` returns but before the step commits, replay invokes `emit` again. Subscribers must tolerate duplicate delivery.

## Cycle Reconciliation

`reconcileCycle` (`packages/reconciler/src/durable/cycle.ts`) converges mutually dependent resources across a bounded number of passes.

### Placeholder Initialization

In pass 1 over `cycle.members`, non-placeholder members reconcile under `notation:deploy:<id>`. Placeholders run `checkPlaceholder` under `notation:deploy:<id>:placeholder:check`:

1. **Snapshot and type check** – `checkPlaceholder` opens a state session and repeats `assertSameType`.
2. **Existing placeholder handling** – For non-`"creating"` records, `checkPlaceholder` calls `setRecordedOutput` and runs `readDriftOperation` when `(opts.driftDetection ?? true) && resource.read`. Unless `driftRead?.kind === "absent"`, it stores `driftRead` in `kept`.
3. **Placeholder creation** – Missing, `"creating"`, or absent placeholders reconcile under `notation:deploy:<id>:placeholder` with `excludeContributionsFrom: members`, leaving out cycle contributions and cycle `dependsOn` edges.

When `opts.dryRun` is true, `reconcileCycle` skips the settle loop. It reconciles only `kept` placeholders once under `settle:1` with `driftDetection: false` and their cached `driftRead`.

### Settle Loop Bounds

After the first pass, `reconcileCycle` computes the pass budget:

```ts [packages/reconciler/src/durable/cycle.ts]
passes += Math.max(2, cycle.members.length);
```

Here `passes` already includes `+1` for every `"replace"` or `"drift-replace"` decision intercepted by `onDecision`. A cycle of `N` members receives at least `2` settle passes and at most `Math.max(2, N) + replaces` passes.

Each pass runs `reconcileResource` with full params under `settle:<pass>` (`driftDetection: false`, `quietNoop: !first`) and collects `changedOutputs(resource, before)` via `resource.toState(...)`. The loop exits when `changed.length === 0 && incomplete.size === 0`, or throws `ResourceCycleError` naming unsettled outputs if the budget expires.

### Incomplete Contribution Tracking

When a delete-first replacement inside a cycle deletes blocking dependents, `replacedWithout(cycle, resource, deleted)` finds cycle peers that `resource` depends on strictly via contributions and that are either `resource` itself or in `deleted`.

If `placeholderParamsBlocker(resource, without)` returns `undefined`, `reconcileCycle` adds `resource` to `incomplete` and creates the replacement without those contributions. A later settle pass restores them and deletes `resource` from `incomplete`.

### Double-Creation Guard

Every create effect ID depends on `(executionId, resourceId, attempt)`. Creating or replacing the same cycle member twice in one execution would hit the first create's cached effect ID instead of executing.

`reconcileCycle` tracks `created` across all passes and throws `recreateError` (`ResourceCycleError`) in `onDecision` if a resource hits `create`, `drift-recreate`, `replace`, or `drift-replace` twice. The error distinguishes replacements caused by changing cycle outputs from re-creates caused by cascading deletes.

Inside `reconcileResource`, if a resumed execution replays an operation whose rotated credential is no longer in memory (`findCredentialsNotReceived`), it re-reconciles under `credentials:refresh:<versions>` with `staleCredentials` so the consumer receives the new value.

## Pending Operation Retries

Cloud operations that have not converged throw `ResourceOperationPendingError`, which `retryPending` (`packages/reconciler/src/operations/operation.pending.ts`) translates into non-blocking durable waits.

### Retry Loop

`retryPending` exports `DEFAULT_MAX_OPERATION_ATTEMPTS = 30` and validates that `maxAttempts` is a positive integer (throwing `RangeError` otherwise). On each iteration `n` from `0` to `maxAttempts - 1`:

1. **Attempt execution** – Invokes `yield* attempt(n, context)`.
2. **Pending interception** – Catches `ResourceOperationPendingError`, saves `error.callbackContext`, and if `n + 1 < maxAttempts`, yields `step.delay(\`${key}:retry-delay:${n}\`, error.retryAfterMs)`.
3. **Exhaustion failure** – Rethrows non-pending errors immediately, or throws `new Error(\`... after ${maxAttempts} attempts\`, { cause: pending })` once `maxAttempts` are exhausted.

### Callback Context

Providers pass opaque progress cursors or polling tokens in `ResourceOperationPendingError.callbackContext`. `retryPending` passes `error.callbackContext` as the second argument to `attempt(n + 1, context)` so long-running operations resume polling without blocking a Node process.

### Error Scrubbing

`runPendingOperation` (`packages/reconciler/src/operations/operation.pending.ts`) wraps each `attempt` in `step.run(\`${key}:attempt:${n}\`, ...)`. It passes rejections through `scrubError(error)` so registered secret strings are stripped before persisting to the step journal.

## Deployment Hold

`packages/reconciler/src/durable/deployment-hold.ts` serializes workflows targeting the same `deploymentId` using `deploymentHoldStore`.

### Hold Acquisition

`acquireDeploymentHold` inspects `notation:hold:inspect`:

- **Contention warning** – If `snapshot.state.holder !== null && snapshot.state.holder !== opts.executionId`, it emits `reconciler.hold.waiting` under scope `notation:hold` naming `holderExecutionId`.
- **Blocking take** – Calls `hold.take("notation:hold:acquire", (state) => state.holder === null || state.holder === opts.executionId, (draft) => { draft.holder = opts.executionId; })`. Competing executions suspend as durable waiters until the holder releases.

### Hold Retention

`withDeploymentHold` (`packages/reconciler/src/durable/deployment-hold.ts`) releases the hold under `notation:hold:release` when `body()` completes normally or throws a terminal error. Two non-terminal cases retain the hold:

- **Durable suspension** – Suspended workflows skip `catch` and replay `hold.take` from cache on resume, keeping concurrent mutations blocked while waiting.
- **Infrastructure error** – When `InfrastructureError.is(error)` is true, `withDeploymentHold` rethrows without releasing so the dispatcher can redeliver under the same hold.

### Manual Hold Clearance

If a process holding a deployment crashes permanently and will never be resumed, operators clear the lock with `clearDeploymentHold` (`packages/reconciler/src/durable/deployment-hold.ts`):

```ts [packages/reconciler/src/durable/deployment-hold.ts]
export type DeploymentHoldClearance =
  | { cleared: true; previousHolder: string }
  | { cleared: false; holder: string | null };
```

`clearDeploymentHold` calls `hold.updateFrom` to check `snapshot.state.holder === fromExecutionId`. It returns `{ cleared: true, previousHolder: fromExecutionId }` on success, or `{ cleared: false, holder }` if the hold is `null` or owned by another execution.
