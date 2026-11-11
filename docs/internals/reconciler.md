# Reconciler

The reconciler expresses deployment and destruction as `@notation/durable` async generators. Notation owns desired-state decisions and provider lifecycle; the caller's `@notation/durable` runtime owns durable execution, waiting, and shared state.

## Deploy flow

`deploy` first [validates](resource.md#value-types) every param it knows, so that a malformed value fails before any change. As in the planner, outputs from state stand in for the outputs of dependencies during this check. It then takes the deployment hold, walks dependency levels in order, decides an action for every resource, executes provider calls as durable steps, persists the result in a resource store, and deletes registered orphans in reverse order of the [edges in state](#dependency-edges).

| Condition                                                                                | Decision           |
| ---------------------------------------------------------------------------------------- | ------------------ |
| Not in state                                                                             | **create**         |
| In state, params changed                                                                 | **update**         |
| In state, an immutable or key param changed, or any param of a resource with no `update` | **replace**        |
| In state, params unchanged, no drift                                                     | **noop**           |
| In state, but deleted from the provider                                                  | **drift-recreate** |
| In state, provider state differs from stored state                                       | **drift-update**   |
| In state, provider state differs in an immutable or key param                            | **drift-replace**  |
| In state, not in graph                                                                   | **delete-orphan**  |
| In state with another type                                                               | plan fails         |

The change decision comes from the resource schema, through `diffParams` in `@notation/resource`. It compares comparable params (`param` items that are not `volatile` or `hidden`) field by field. A changed field forces replacement when its schema item is `immutable`, `primaryKey` or `secondaryKey`, or when the resource has no `update` operation. A change anywhere inside such a field replaces the whole resource. If the changed field's schema item has `rejectReplace`, and the new value is known, plan and deploy fail with its message instead.

An `undefined` param counts as absent, so an optional param left unset never looks changed. Drift compares only fields that both the desired params and the read output have: a read need not return every param, and it reports defaults for params left unset, and neither is drift.

Replacement deletes the resource and then creates it again, because a resource usually takes its physical name from its params and the new one would collide with the old. Each half is durable: the delete removes the state record, and the create writes a new one with a new instance ID. A crash anywhere in between resumes where it stopped. If the create fails for good, the resource and its record are both gone, and the next deploy plans **create**.

The dependents of a replaced resource stay in place. When deploy reaches each of them, it decides again with the outputs of the new resource. A dependent whose params change is updated, or replaced if a changed param forces replacement. For example, replacing a Lambda role updates the function's `Role`, and does not delete the function or its log group. A dependent whose type blocks the delete of the replaced resource is deleted first instead. See [Dependents of a replaced resource](#dependents-of-a-replaced-resource).

An unknown immutable or key param plans **replace** with the field marked "unknown, may force replacement". The planner treats a replaced resource's output as unknown, so its dependents plan against unknown params, and can show **replace** in turn. Deploy decides again for each resource once its dependencies have converged, with real params, so it replaces only what really changed. [Unknown values](#unknown-values) explains when plan marks a param unknown.

A resource can't change type under the same ID, as its class would read, update or delete the resource of another class. When a state record's type differs from the type of the resource with its ID, plan and deploy throw `ResourceTypeChangedError` before any change. Destroy deletes such a record through the class of the record's type instead, so destroy does not need code to agree with state. When that class is not registered, destroy keeps the record and every resource it depends on, and emits `reconciler.orphan-deletion.skipped`. A provider that changes the type of a resource gives it a new ID instead. The new resource is then created in the dependency walk, and the old record is deleted in the orphan sweep after the walk, so the new resource exists before the old one is deleted. The old type's class must stay registered for the sweep to delete it.

### Dependents of a replaced resource

A provider can refuse to delete a resource while other resources use it. For example, AWS does not delete an EventBridge bus that has rules. The type of the dependent lists the types it blocks the delete of, in its definition:

```ts
const eventBridgeRule = resource<EventBridgeRuleSchema>({
  type: "aws/eventBridge/rule",
  blocksDeleteOf: [EventBus.type],
});
```

Set `blocksDeleteOf` only when the provider refuses to delete a resource of the listed type while a resource of this type depends on it. Each dependent it applies to is deleted and created again, and is gone in between. When importing the class would make an import cycle, write the type as a string literal. Nothing checks that a listed type exists, so a mistyped type is ignored. The resource class exposes the list as `blocksDeleteOf`, as it exposes `type`. In `@notation/aws/resources`, only `EventBridgeRule` sets it. It does not list `DefaultEventBus`, which is never deleted.

A dependent blocks the delete of a resource when it depends directly on the resource, and its class lists the type of the resource in `blocksDeleteOf`. A dependent that reaches the resource only through a resource that does not block its delete is not deleted. When deploy replaces a resource, it runs these steps:

1. Deploy deletes each dependent that blocks the delete of the replaced resource. It does the same for each dependent that blocks the delete of a resource deleted in this step. It deletes them in reverse order of the [edges in state](#dependency-edges). Then it deletes the resource.
2. Deploy creates the resource again.
3. Deploy creates the deleted dependents again when it reaches them in the dependency levels. Each has no state record now, so its decision is **create**, and its params use the outputs of the new resource.

Every other dependent stays in place, and goes through the normal decision when deploy reaches it. For example, when a bus is renamed, its rules are deleted in step 1. The Lambda permission of a rule does not block the delete of the rule, so it stays in place. When deploy reaches it, the rule exists again with a new ARN, so the permission is replaced because its `SourceArn` changed. A function whose `env` holds the bus's name is updated in place.

When no class in code or in the registry lists the type of the replaced resource, deploy skips step 1, and does not list the state records.

Step 1 lists the state records when the replacement starts. A resource that deploy has already reached in this run has the edges in code in its record. A resource that deploy has not reached yet still has the edges of the resource that exists in the provider. A record written before edges were recorded uses the edges in code.

Each resource is checked with the class of the type in its state record. Deploy finds the class among the classes of the resources in code and the classes in the registry, so state holds nothing extra for this. An orphan that blocks the delete is deleted in step 1, before the sweep. This is so even when an orphan with no registered class depends on it, which the sweep would keep. If the provider refuses that delete, the deploy fails.

An orphan whose type has no registered class is treated as not blocking the delete.

On the CLI, plan and deploy register the classes of the provider packages that state names (see [Dependency edges](#dependency-edges)), so an orphan's type has no registered class only when its package is not installed or no longer exports the class. For example, if the deploy that renames a bus also removes the last EventBridge rule in code, the rule's class still comes from `@notation/aws/resources`, and deploy deletes the old rule before the bus.

When an orphan's class can't be loaded, deploy deletes the resource it depends on without deleting the orphan first, and the provider refuses the delete. Deploy may already have deleted other dependents in step 1. The next deploy creates them again, and fails in the same way. To fix this, install the provider package again, or declare a resource of the orphan's type again.

Some cases:

- A dependent that is replaced for its own reasons is deleted in step 1, and created once with its new params.
- A dependent of several replaced resources is deleted with the first of them. The later replacements find no record for it, so they skip it. It is created once, after all of them.
- A dependent that is created in this deploy has nothing to delete.
- **drift-recreate** finds the resource gone from the provider, so it deletes nothing, and its dependents are not deleted.
- A dry run emits **dry-run** for each delete and changes nothing. It keeps the records, so the rest of the run decides for each deleted dependent as if it still exists, and the sweep emits the delete of an orphan among them a second time.

The delete events of the dependents carry `reason: "dependency-replaced"` and `replacedDependency`, the ID of the replaced resource.

Each delete is durable and removes the dependent's record, so state stays consistent if the deploy stops part way. A crash resumes where it stopped. If the deploy fails, the next deploy finds no record for each deleted dependent, and plans **create** for it. The replaced resource still has its old record if its own delete has not finished, so the next deploy plans **replace** again and deletes the dependents that remain.

Plan finds the same dependents with the same code. It shows each dependent in code as **replace**, with `replacedDependency` set to the ID of the replaced resource, as in the delete events. `notation plan` prints a line under it:

```
-/+ replace aws/eventBridge/rule eventbridge-pattern-rule:order-placed
    deleted before eventbridge-bus:orders is replaced
```

When the replaced resource depends on a field that is unknown at plan, its own entry says "unknown, may force replacement". Its dependents are shown as **replace** in the same way, and `notation plan` prints `deleted if eventbridge-bus:orders is replaced`, because deploy deletes them only if it replaces the resource.

## Dependency check

Before plan or deploy does anything else, `assertDependenciesPresent` (`packages/reconciler/src/dependency-graph.ts`) checks every dependency of every resource. A resource gets dependencies in four ways:

- declared in its `dependencies`
- added with `dependOn`
- held as an output value in its config or contributions
- named in the `deps` of a function contribution

A dependency must be part of the deployment, because the graph ignores an edge to a resource that is not in it. Without the check, nothing would deploy the dependency, and the dependent would wait on an output that never arrives. So the check fails with:

```
policy depends on bucket, which is not part of this deployment. Add bucket to a resource group.
```

Two cases pass:

| Case                                                              | Why it passes                                          |
| ----------------------------------------------------------------- | ------------------------------------------------------ |
| An optional dependency left empty, such as a route with no `auth` | An empty slot adds no edge.                            |
| A dependency outside the deployment whose output is already set   | Its output can be read, so nothing needs to deploy it. |

Destroy does not run the check, so broken infra code cannot block a teardown.

## Unknown values

At plan, some resources have not been created yet, so their outputs do not exist. Plan marks a param that needs one of these outputs as unknown. **The rule from RFC 0002 decides every case below: plan may show more unknowns than deploy finds, but must never show a known value that deploy would change.**

**Output values.** Plan fills in each output value from the outputs in state. When the resource has no output yet, plan marks the value unknown at its own path, and the rest of the map stays visible.

**`deriveParams`.** Plan calls `deriveParams` with a view of each dependency. Reading the view's `output` throws `PendingOutput` when the dependency has no output yet. Plan cannot tell which params depend on that output, so it handles each result like this:

| `deriveParams` at plan                         | Plan shows                                |
| ---------------------------------------------- | ----------------------------------------- |
| reads no pending output                        | the params it returns, as known           |
| reads a pending output, then returns or throws | every param not set in config, as unknown |
| throws without reading a pending output        | an error: the plan fails, as deploy would |

A dependency whose output `deriveParams` never reads only orders the deploy, so it does not make any param unknown.

**Function contributions.** Plan runs each function contribution with the same views. When the function reads a pending output, whether it then returns or throws, plan marks every collected param of the receiving resource unknown. When it throws without reading one, the plan fails. Otherwise plan uses the function's result.

## Dependency edges

Each state record stores the IDs of the resources it depends on in `dependsOn`, sorted. Create, update and replace write the edges with the rest of the record. When a resource is a **noop** but its edges differ from those in state, deploy rewrites only `dependsOn`, and does not call the provider. The plan still shows the resource as a noop. A dry run does not rewrite edges.

The sweep deletes orphans in reverse order of these edges, as deploy and destroy do for resources in the graph. A replacement deletes the dependents that block its delete in the same order; see [Dependents of a replaced resource](#dependents-of-a-replaced-resource). An edge to a resource that is not an orphan is ignored, including an edge to a resource that is no longer in state. A record written before edges were recorded has no `dependsOn`, and keeps its storage order among the orphans it has no edges to. The next deploy that reaches the resource writes its edges.

Orphans that form a cycle cannot be ordered. They, and the orphans that depend on them, are deleted first, in storage order, so a provider that refuses one of the deletes fails the deploy. An orphan in this group with no registered class does not keep the orphans it depends on in the group, as the sweep can delete them before it reaches the orphan.

The sweep looks up an orphan's class by its type in the caller's `registry`, merged with the classes of the resources in the graph. Each state record stores the provider of its resource in `provider`, a package name or a package subpath, which the resource class declares with `resource({ type, provider })`. `deployApp` and `destroyApp` in `@notation/core` collect the providers that state names, in a `notation:providers` step, and pass the resource classes that each provider exports. Only the records whose type has no class in the graph count, as the graph's classes cover the others. Each provider is resolved with `createRequire` from the project root, and then imported. A provider package is not always a direct dependency of the project, and pnpm does not link a transitive package into the project's `node_modules`. So a package that the root can't resolve is resolved from the real directory of each package in the project's dependency tree, breadth first, starting from the nearest `package.json` at or above the root, as Node resolves it when that package imports it. The walk stops at the first directory that resolves the package. If the tree holds two versions of a package, the first one found is loaded. A package is skipped, and a `reconciler.provider.load-failed` warning names it with the cause, when it can't be resolved, resolves to a builtin module such as `fs`, throws on import, or exports no resource classes that declare it as their provider. The loader takes the resource classes among the module's exports and among the values of each exported object, so a namespace export such as `lambda` is read. It reads `default` in the same way, because `import()` puts a CommonJS module's exports there. Other exports are ignored. A class whose `provider` is another package is ignored too, so each type is loaded only from the provider that its state record names. A provider name may contain only letters, digits, `_`, `.`, `~` and `-`, with an optional leading `@` and `/` between segments, and no segment may start with a dot. A record whose provider is not such a name, such as a relative path, an absolute path or a Windows drive path, is skipped in the same way. A record with no `provider` was written by an earlier version, and plan, deploy and destroy fail on it at the start. Deploy and destroy emit the warning in a step under `notation:providers:<package>`, so a resumed execution does not emit it again. The sweep's `reconciler.orphan-deletion.skipped` warning still names each record that is left in place. Core does not list the provider packages, so a provider from outside this repository works the same way. `planApp` loads the same packages without a step, so plan finds the same blocking dependents as deploy. Without these classes, a record whose type no longer appears in the graph could not be deleted. The packages are read before the deployment hold. So when an execution waits on another's hold, it does not have the packages of the records that the other execution writes, and its sweep skips those records as orphans until the next deploy.

When an orphan's type has no registered class, the sweep keeps the orphan and every orphan it depends on, directly or through another orphan. In destroy, it also keeps every resource in the desired set that the orphan depends on, directly or through another kept resource, and destroy does not delete those resources. The `reconciler.orphan-deletion.skipped` warning names the kept resources in `keptDependencies`. Each orphan with no registered class emits its own warning, including an orphan that another skipped orphan already keeps.

Dry-run deploy performs decisions and emits lifecycle events without provider mutations or state mutations. When drift detection is enabled, it can still call provider read operations to decide whether a nominal noop has drifted.

## Destroy flow

`destroy` is a first-class durable operation. It takes the same deployment hold as deploy, deletes registered persisted orphans, deletes desired resources in reverse dependency order, and conditionally removes each resource store only after the provider delete succeeds or reports that the resource is already absent. Orphans go first, because an orphan can depend on a desired resource, but no desired resource depends on an orphan.

## Waiting and replay

Provider calls are stable durable steps, but provider acknowledgement and the `@notation/durable` heap checkpoint are not atomic. If the process crashes between them, replay repeats an update or delete call, so those operations must be idempotent. Each create attempt runs as a `@notation/durable` `step.effect`. After a crash, the reconciler looks the resource up before it calls create again, when the resource can be found; see [Unknown create outcomes](../reference/resource.md#unknown-create-outcomes). Event subscribers must likewise tolerate duplicate delivery when a crash occurs before the event checkpoint.

A resource operation throws `ResourceOperationPendingError` when it has not finished. The error gives the reconciler a delay and optional callback context. The runtime stores the context, waits without keeping the process busy, and calls the same operation again. From `create`, `update` or `delete`, the error means that the call made no change and can be made again, for example while an IAM role propagates. From `read`, it means that the resource exists and has not reached a stable state, so calling `read` again polls it. See [Operation errors](../reference/resource.md#operation-errors) for the complete API.

Each attempt, delay, event, state read, state write, and hold change has a stable step key. A resumed execution must use the same execution ID. A new deploy or destroy must use a new execution ID.

## State and the deployment hold

Each resource is stored under `notation/resource-state` with a deployment-scoped ID. Conditional updates and deletes compare the snapshot's UUIDv7 `instanceId` and version, so a stale execution cannot modify a deleted and recreated store.

Deploy and destroy take an exclusive hold on the deployment through one `notation/deployment-hold` store per deployment. `store.take` suspends a competing execution as a durable waiter and wakes it after the holder releases. A waiter that finds the hold already taken when it inspects it emits `reconciler.hold.waiting` naming the holding execution ID, so a wait behind a crashed execution is visible instead of silent; a holder that appears only between that inspection and the `take` suspends the waiter without the event.

A suspended execution keeps its hold, which is what makes resuming it safe. An execution that ends a delivery with an infrastructure error also keeps its hold, because the dispatcher delivers it again. When the workflow throws, the execution fails permanently and releases its hold under `notation:hold:release-failed`. The hold of a crashed execution that will never be resumed is cleared with `clearDeploymentHold` from `@notation/reconciler/durable`.

## Events

The durable workflows emit these events:

| Event                                | When                                                                          |
| ------------------------------------ | ----------------------------------------------------------------------------- |
| `reconciler.deploy.decision`         | After deciding what action to take for a resource                             |
| `reconciler.drift.detected`          | When drift is found between stored and actual state                           |
| `reconciler.operation.lifecycle`     | When an operation starts, finishes, skips, or fails                           |
| `reconciler.hold.waiting`            | When another execution holds the deployment                                   |
| `reconciler.orphan-deletion.skipped` | When no registered class can delete an orphan; names the orphans kept with it |
| `reconciler.provider.load-failed`    | When a provider package that state names can't be resolved or imported        |

Lifecycle events cover create, read, update, and delete with `start`, `success`, `error`, `skip`, or `dry-run` status. The delete of a dependent that blocks the delete of a replaced resource has `reason: "dependency-replaced"`, and names the replaced resource in `replacedDependency`.
