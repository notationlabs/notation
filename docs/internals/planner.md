# Planner

The planner simulates a deployment against persisted state without executing provider mutations. `createPlan` (`packages/reconciler/src/planner.ts`) shares validation, ordering, diffing, drift, cascade, and provider-loading helpers with the pre-flight phase of `deploy`.

## Dependency Validation

Before planning or deploying, `assertDependenciesPresent` (`packages/reconciler/src/dependency-graph.ts`) checks that every dependency is either in the graph or already resolved. Without this check, topological ordering ignores edges to absent IDs and dependents would read missing outputs.

### Dependency Sources

A resource collects dependencies from four sources in `resource.getDependencies()`:

| Source | Description |
| :--- | :--- |
| Explicit declarations | Resources passed in `dependencies` during construction |
| Imperative edges | Resources added via `dependOn` |
| Output references | `OutputRef` targets in config or contributions |
| Function contributions | Deprecated `contribute` dependencies passed via `deps` |

Output references exclude `StateRef` (`~state`) and `OwnPhysicalName` (`~physicalName`) self-references.

### Validation Rules

`assertDependenciesPresent` inspects every resource's `getDependencies()` set and fails unless `present.has(dependency)` or `dependency.output != null`:

| Case | Behavior |
| :--- | :--- |
| Empty optional slots | Adds no edge and passes |
| External dependencies | Passes when `dependency.output != null` |
| Destroy workflow | Skips `assertDependenciesPresent` so broken code cannot block teardown |

## Topological Ordering

The reconciler orders resources in waves so dependencies converge first. Mutual dependencies stay grouped as a single unit.

### Depth Levels

`buildDepthLevels` (`packages/reconciler/src/dependency-graph.ts`) runs Kahn's algorithm with deterministic tie-breaking:

| Behavior | Description |
| :--- | :--- |
| Duplicate IDs | Throws `Duplicate resource id: <id>` when two items share an ID |
| External edges | Ignores dependency IDs absent from `items` |
| Ready waves | Sorts each wave by original `itemOrder` index to keep declaration order |
| Cycles | Returns `{ levels, unordered }` with cycle members and transitive dependents |

`unordered` preserves input order.

### Strongly Connected Components

`findStronglyConnected` (`packages/reconciler/src/cycles.ts`) runs an iterative (non-recursive) Tarjan SCC search over `items` and `edgesOf`, sorting each component back into input order. `orderDeployUnits` (`packages/reconciler/src/cycles.ts`) uses those components to build `DeployUnit[]`:

- **Component graph** – Sorts SCCs by each first member's input position and orders component indices with `buildDepthLevels`.
- **Loop detection** – `isLoop(members, edgesOf)` returns `true` when `members.length > 1` or when `edgesOf(members[0]).includes(members[0])`.
- **Acyclic units** – Single-node components without self-loops become `{ members, placeholders: [] }`.

### Cycle Placeholder Selection

When `isLoop` is true, `resolveCycle` greedily breaks loops until no strongly connected loop remains:

```ts [packages/reconciler/src/cycles.ts]
const edgesOf = (resource: BaseResource) =>
  (placeholders.has(resource)
    ? resource.getFixedDependencies()
    : resource.getDependencies()
  ).filter((dependency) => inCycle.has(dependency));
```

Each iteration recomputes `findStronglyConnected(members, edgesOf)`. It picks the first non-placeholder member in input order of each remaining loop whose `placeholderBlocker` returns `undefined`.

`placeholderParamsBlocker` (`packages/reconciler/src/cycles.ts`) enforces three requirements on a placeholder candidate:

| Requirement | Description |
| :--- | :--- |
| Contribution-only loop edges | At least one loop dependency comes strictly from contributions |
| Updatable resource class | `resource.update` exists so a second pass can apply omitted contributions |
| Optional non-replacing params | Contributed peer params are optional and do not force replacement |

Specifically, every param in `resource.getContributedParams({ from: peers })` must not have `presence === "required"` and must not satisfy `forcesReplacement(item)`. If no loop member qualifies, `resolveCycle` throws `ResourceCycleError` (`packages/reconciler/src/cycles.ts`) with each candidate's blocker reason. Once all loops break, `resolveCycle` returns `{ members: ordered, placeholders }` with placeholders ordered before dependents.

## Plan Simulation

`createPlan` walks `orderDeployUnits(resources)` and builds `PlanNode[]` using the same decision rules as [Durable Execution](./durable-execution.md). Before walking units, it runs four setup steps:

| Step | Description |
| :--- | :--- |
| Dependency check | Calls `assertDependenciesPresent` |
| Override check | Runs `assertOverrides` when `overrides` is supplied |
| Identifier resolution | Computes `identified` overrides via `withStateIdentifiers` |
| State reference snapshot | Reads `~state` targets via `readRecordedOutputs` |

Running `assertOverrides` requires `deploymentId`.

### Parameter Resolution

For a cycle unit, `loadUnit` first runs `loadOutput` on every member so later members' state outputs are available to earlier ones. `planKnownParams` (`packages/reconciler/src/planner.ts`) then prepares inputs for each resource:

1. **Hidden credential check** – `assertNoHiddenCredential` rejects any `CredentialRef` targeting a `hidden` param. State omits hidden fields, which would trigger rotation on every deploy.
2. **Type verification** – `loadOutput` calls `assertSameType`, throwing `ResourceTypeChangedError` if `stateNode.type !== resource.type`. For non-`"creating"` records, it also calls `setRecordedOutput`.
3. **Partial parameter evaluation** – `resource.planParams({ recordedOutputs })` resolves known refs and leaves pending outputs as `UNKNOWN_AFTER_APPLY`.
4. **Physical name overlay** – `assertNamesNotSupplied` rejects `physicalName` fields set by config or `deriveParams`. `fillPhysicalNames` applies `unknownNames(resource)` overridden by `recordedNames(names, stateNode)` (including `"creating"` records).
5. **Validation** – `validateParams(resource, params, "plan")` checks all known values before deciding actions.

### Action Decisions

`decideAction` (`packages/reconciler/src/plan.ts`) determines the initial `ResourceAction`:

| Action | Condition |
| :--- | :--- |
| `create` | No state record exists or `isCreatingRecord(stateNode)` is true |
| `replace` | `diffParams` produces `replaceFields` or `replaceOverride` is set |
| `update` | `patch` is non-empty and `replaceFields` is empty |
| `noop` | Both `patch` and `replaceFields` are empty |

When `isCreatingRecord(stateNode)` is true, `PlanNode.mayTakeOver` is set to `true`. `diffParams` runs with `{ canUpdate: Boolean(resource.update) }`, and `replaceOverride` appends `{ requested: true, known: true }` to `replaceFields`.

Before returning, `decideAction` runs `assertReplaceAllowed` on known `replaceFields` with `rejectReplace`. Running this before `rejectChange` preserves param-level error messages. It then runs `assertChangeAllowed` unless `replaceOverride?.overrideLossProtection` is `true`.

Credential sources run `planSource` instead. If `containsUnknownAfterApply(params)` is true, `planSource` clears output to `null` and returns `create` (no record) or `update` (existing record). Otherwise it runs `readAndDecideSource`.

### Drift Detection

When `decideAction` returns `noop` and `!replaceOverride`, `createPlan` runs `applyDriftDetection` (`packages/reconciler/src/operations/operation.read.ts`). Drift detection is enabled by default unless `driftDetection === false` or `!resource.read`.

If the read throws `ResourceNotFoundError`, `readDriftOperation` returns `{ kind: "absent" }` and `decideDriftAction` (`packages/reconciler/src/plan.ts`) returns `drift-recreate`. Otherwise, `decideDriftAction` intersects fields with `pick(values, other)` before calling `diffParams`:

```ts [packages/reconciler/src/plan.ts]
function pick(
  values: Record<string, unknown>,
  other: Record<string, unknown>,
): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && other[key] !== undefined) picked[key] = value;
  }
  return picked;
}
```

Intersecting with `pick` prevents false drift when `read` omits a param or returns provider defaults for unset fields.

### Credential Planning

For each kept resource (`noop`, `update`, or `drift-update` per `keepsResource`) with a non-`"creating"` record, `createPlan` calls `mintedCredentials` (`packages/reconciler/src/unobtainable-credential.ts`) to compute `rotates`:

- **Explicit `--credential` targets** – Always included in `rotates`.
- **Consumer mismatches** – `getCredentialsToMint` detects `no-version`, `consumer-added`, `consumer-create-unfinished`, and `consumer-behind` via `getChangedCredentials` against `record.params`.
- **Missing `rotate` handler** – Credentials needing a value without `producer.rotate?.[name]` go into `unobtainable` via `unobtainableCredential(...)`.

Whenever `rotates.length > 0`, `createPlan` marks those outputs `UNKNOWN_AFTER_APPLY` on `resource` so downstream consumers plan updates.

After planning any non-kept node, `planLateRotations` inspects `findCredentialMarkers(node.params)` for earlier kept producers that did not rotate that credential. For each match, it calls `rotatesForCreate`, appends the credential to `producerNode.rotates`, and re-plans kept siblings in `planned`. Sibling re-plans disable drift detection and merge drift diffs when `first.decision === "drift-update"`.

At the end of all units, `throwIfUnobtainable(unobtainable, identified)` throws `UnobtainableCredentialError`. Missing credentials are deduplicated by `<producer>.<name>`.

### Cycle Re-planning

For a cycle unit, `createPlan` runs a second pass over members preceding a replaced member:

- **Replaced output invalidation** – When `planResource` plans a replaced resource, it resets `resource.setOutput(null as any)`. It also replaces `physicalName` params with `unknownNames(resource)`.
- **Predecessor re-evaluation** – After planning `unitNodes`, `createPlan` finds the last `replace` or `drift-replace` index. Every earlier `noop` or `update` member re-runs `planResource(members[index], cycle, false)` so its `PlanNode` sees unknown outputs instead of stale state.

## Delete Cascades

Replacements choose an ordering strategy and, for delete-first replacements, simulate cascading deletions of blocking dependents.

### Replacement Ordering

`replaceOrder` (`packages/reconciler/src/physical-names.ts`) returns `"create-first"` when `resource.replaceCreatesFirst || nameFields(resource).length > 0`, and `"delete-first"` otherwise. Any resource deleted because of a dependency cascade (`replacedDependency`) is always forced to `"delete-first"` regardless of its class.

### Blocking Dependents

For a `"delete-first"` replacement, `createPlan` computes cascading deletes from `edgesById` merged with `retiredEdgesById`:

1. **Block predicate** – `createBlocksDelete` (`packages/reconciler/src/delete-cascade.ts`) checks `resolveResourceClass(registry, dependent.type)?.blocksDeleteOf.includes(dependency.type)`. Records with `kind === "credential-source"` or without a registered class never block deletes.
2. **Transitive collection** – `collectDependents` (`packages/reconciler/src/dependency-graph.ts`) runs a DFS from `resource.id` along reverse edges where `follows(dependentId, dependencyId)` is true. It orders discovered IDs via `buildDepthLevels` and returns `[...unordered, ...levels.reverse().flat()]`.
3. **Cascade node projection** – Each cascaded ID is recorded in `cascaded.set(id, resource.id)` and removed from `edgesById` and `retiredEdgesById`. Unreplaced cascades run `assertChangeAllowed(..., { replace: true })` and emit `decision: "replace"`, `replaceOrder: "delete-first"`, and `replacedDependency`.

### Broken Dependents

When a `"delete-first"` replacement sets `resource.deleteTakesDependents`, `createPlan` inspects remaining `edgesById` entries after removing cascaded IDs. Any declared resource still referencing `resource.id` populates `PlanNode.brokenDependents` in sorted order.

## Orphan Sweep Planning

After planning all declared units, `createPlan` simulates the end-of-deploy sweep using `sweptRecords` and `sweepSteps` (`packages/reconciler/src/orphan-sweep.ts`).

### Sweep Ordering

`sweptRecords(stateNodes, inCode)` selects every orphan (`!inCode.has(node.id)`) and every declared record with `node.retired?.length`. `sweptEdges` builds delete dependencies for each swept record:

- **Orphans** – Combines `node.dependsOn ?? []` with every `instance.dependsOn` in `node.retired`.
- **Declared records** – Uses only `retired` edges because the live resource now points to its replacement.

`orderSweep` runs `buildDepthLevels` over those edges and returns `[...unordered, ...levels.reverse().flat()]`. Dependents delete before dependencies, while cycle orphans and records without recorded edges delete first in storage order.

### Unregistered Types

For each swept record in delete order, `sweepSteps` resolves a class with `resolveRecordClass` (`packages/reconciler/src/resource-registry.ts`):

- **Credential source fallback** – Records with `kind === "credential-source"` receive a synthetic `RecordedSource` class whose delete requires no provider package.
- **Dependency retention** – If an orphan has no registered class, `keep` (`packages/reconciler/src/orphan-sweep.ts`) walks `edgesById` via `collectDependencies` and adds the orphan plus transitive swept dependencies to `kept`. It always emits a step with `keptDependencies` so every missing type surfaces.
- **Plan visibility** – `createPlan` checks `assertOrphanDeleteAllowed` on registered orphans and skips `kept` registered steps during simulation. Un-swept orphans still appear at the end of `Plan.nodes` as `delete-orphan` nodes.

### Retired Instance Nodes

`retiredNodes(stateNode)` expands each `RetiredInstance` entry into a `delete-retired` `PlanNode` carrying `retiredIndex`, `retiredAt`, `params`, and `dependsOn`:

- **Delete-first records** – Emitted immediately before the resource's own `replace` node (`deletedWithRecord.add(node.id)`).
- **Sweep records** – Emitted during the `sweepSteps` walk for every record with a registered class not in `deletedWithRecord`.

## Override Validation

CLI override flags (`--replace`, `--override-loss-protection`, `--credential`) are parsed and verified by `packages/reconciler/src/overrides.ts` before state mutations occur.

### Target Parsing

`parseReplaceTarget` and `parseCredentialTarget` (`packages/reconciler/src/overrides.ts`) split target strings from the right so IDs may contain `@` or `.`:

- **`parseReplaceTarget`** – Splits at `lastIndexOf("@")`. The suffix becomes `instanceHash` (lowercased) only when `at > 0` and it matches `/^[0-9a-f]{8}$/i`.
- **`parseCredentialTarget`** – Splits `variable` at `lastIndexOf("=")` and treats `@` as a hash delimiter only when `at > left.lastIndexOf(".")`. The remaining `<id>.<credential>` splits at `lastIndexOf(".")`.

### Instance Hashes

`instanceHash` (`packages/reconciler/src/overrides.ts`) binds overrides to a specific stage and physical primary key:

```ts [packages/reconciler/src/overrides.ts]
const key = primaryKeyNames(resource.schema)
  .sort()
  .map((name) => [name, record.output[name] ?? null]);
return createHash("sha256")
  .update(JSON.stringify([deploymentId, key]))
  .digest("hex")
  .slice(0, 8);
```

`withStateIdentifiers` populates missing `instanceHash` values on plan targets from non-`"creating"` records so `UnobtainableCredentialError` and `notation plan` print exact `notation deploy` commands.

### Precondition Checks

`assertOverrides` (`packages/reconciler/src/overrides.ts`) enforces all override invariants for `point: "plan" | "deploy"`:

- **Loss protection pairing** – Every ID in `overrideLossProtection` must appear in `replace`.
- **Replace targets** – Must exist in both `resources` and `records`, cannot be a `"creating"` record or credential source, and must carry a matching `instanceHash`. `deploy` requires the hash, `plan` validates it when given, and `assertHashWellFormed` rejects wrong-length hex suffixes.
- **Credential targets** – Must have unique `<id>.<name>`, exist in `resources` and non-`"creating"` `records`, and avoid credential sources or `--replace` on the same ID. The schema property must be `"credential"`, `resource.rotate?.[name]` must be absent, `instanceHash` must match, and `process.env[variable]` must be non-empty on `deploy`.
- **Replaced producers** – `assertNoPassedCredential` rejects `--credential` when a resource is replaced or recreated.

## Provider Package Loading

When resources are removed from TypeScript declarations, their types are no longer imported by the application graph. `@notation/core` loads missing provider classes dynamically from each state node's `provider` field.

### Package Discovery

`stateProviderPackages` (`packages/core/src/provisioner/resource-registry.ts`) collects sorted unique `node.provider` strings for state records whose `type` is absent from `resources`. It skips `kind === "credential-source"` records and throws if any record lacks a string `provider` field.

### Dependency Tree Resolution

`loadProviderRegistry` (`packages/core/src/provisioner/resource-registry.ts`) resolves each package without relying on hoisted root dependencies:

1. **Specifier validation** – Rejects any `provider` failing `/^@?[\w~-][\w.~-]*(\/[\w~-][\w.~-]*)*$/`. This blocks relative, absolute, and drive-letter file imports from state records.
2. **Root and tree resolution** – `resolvePackage` first calls `createRequire(path.join(root, "package.json")).resolve(name)`. On `MODULE_NOT_FOUND`, it walks `cachedDependencyDirs(root)` breadth-first; non-`MODULE_NOT_FOUND` errors fail immediately.
3. **Realpath symlink walk** – `dependencyDirs` locates the nearest `package.json` via `manifestDir(root)` and reads `dependencies`, `optionalDependencies`, and project-root `devDependencies`. `findPackageDir` resolves each dependency through `fs.realpathSync` so pnpm finds sibling dependencies next to real store directories.
4. **Builtin rejection** – Skips any resolved entry where `!path.isAbsolute(entry)`, blocking Node builtins such as `fs`.

### Export Filtering

`loadProviderRegistry` imports `pathToFileURL(entry).href` for each resolved file. It inspects top-level exports, `module.default`, and namespace export objects via `resourceClassesIn`, keeping classes where `Resource.provider === name`.

Any failure to validate, resolve, import, or match classes emits `reconciler.provider.load-failed` instead of aborting. `loadPlanProviderRegistry` emits warnings directly during `planApp`. `loadStateProviderRegistry` (`packages/core/src/provisioner/resource-registry.ts`) caches the package list in `notation:providers` and emits each warning inside `notation:providers:<encodedPackage>:emit` so resumed workflows avoid duplicate warnings.
