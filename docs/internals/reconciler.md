# Reconciler

The reconciler expresses deployment and destruction as `@notation/durable` async generators. Notation owns desired-state decisions and provider lifecycle; the caller's `@notation/durable` runtime owns durable execution, waiting, and shared state.

## Deploy flow

`deploy` first [validates](resource.md#value-types) every param it knows, so that a malformed value fails before any change. As in the planner, outputs from state stand in for the outputs of dependencies during this check. It then takes the deployment hold, walks dependency levels in order (resources that depend on each other are deployed together; see [Dependency cycles](#dependency-cycles)), decides an action for every resource, executes provider calls as durable steps, persists the result in a resource store, and deletes registered orphans in reverse order of the [edges in state](#dependency-edges).

| Condition                                                                                | Decision           |
| ---------------------------------------------------------------------------------------- | ------------------ |
| Not in state, or in state with a `creating` record                                       | **create**         |
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

### Recoverable creates

Before deploy calls a resource's `create`, it writes a `creating` state record, under the step key `state:persist:<id>:creating`. The record holds the resource's config, params and dependency edges, and the key fields that params supply. It also lists, in `creates`, the IDs of the executions whose creates may have made the resource. An execution's create token is `notation:create:<execution id>:<resource id>`, and every attempt of its create receives the same token, so a later execution can compute the token from the list. Each attempt's effect ID adds the attempt number to the token. A `creating` record that an earlier execution left keeps its entries, and the new execution adds its own. If the new execution's create fails and its outcome is known, deploy writes the earlier record back, without the new entry. The entries are kept when config changed the key too, because `find` checks the desired key as well as the token. When the create is done, deploy replaces the record with the usual record, which has no `creates`.

A `creating` record that deploy writes over a full record, in a drift-recreate, also keeps that full record, in `recorded`. A `creating` record written over a `creating` record carries its `recorded` forward. The record that replaces a `creating` record has no `recorded`. See [The record after a failed create](#the-record-after-a-failed-create).

#### The ownership rule

Deploy takes over or deletes an existing resource only with proof that one of Notation's own creates made it. Each resource class says how the proof is made, in its `ownership` field:

- `token`: `create` records the create token on the resource, for example as a tag, and `find(params, token)` checks it. Deploy calls `find` with the token of each execution that the record lists, and of the current execution, and takes the resource over if one of them finds it. The calls run in one step, `create:prove`.
- `parent`: the resource lives inside another resource that Notation owns, such as a statement in a Lambda function's policy, so any resource with the desired key is Notation's. A class with `find` uses it to find the resource's key, as API Gateway's `Route` finds a route by its route key. A `find` that throws `ResourceNotFoundError` refuses the resource. `LambdaLogGroup` has no `find`, so deploy takes over any log group with the function's log group name. Lambda makes that log group itself when the function first logs, and keeps it after the function is deleted.
- No `ownership`: nothing proves it. Deploy never takes the resource over, never looks up a create with an unknown outcome, and never deletes the resource of a `creating` record, unless the record was written over a full record (see [Deleting the resource of a creating record](#deleting-the-resource-of-a-creating-record)).

A class that defines `find` must set `ownership`, and a class with `ownership: "token"` must define `find`. `defineOperations` throws otherwise.

The proof is checked when `create` throws `ResourceAlreadyExistsError`. `ResourceAlreadyExistsError` fails the create attempt's effect, whatever lookups ran before it, so a provider whose reads lag behind can't make deploy wait for the resource to show. With `ownership: "parent"`, the proof holds for this execution's own record too, except for the create of a replacement, whose record was removed with the resource it replaces. When deploy refuses the create of a replacement, it removes the replacement's `creating` record, so the next deploy plans a create and takes the resource over through its parent.

The lookup of a create with an unknown outcome follows the same rule; see [Unknown create outcomes](../reference/resource.md#unknown-create-outcomes). With `ownership: "token"`, it calls `find` with the execution's token. With `ownership: "parent"`, it calls `find`, or reads the resource by a key made of params. Without `ownership` there is no lookup, so the outcome stays unknown and the deploy fails. The next deploy finds the `creating` record, and refuses the resource if it exists.

#### Taking a resource over

A new execution, after the old one was abandoned with `clearDeploymentHold`, can't read the old execution's journal. It finds the `creating` record instead, and plans **create**. Plan sets `mayTakeOver` on the create node when the class has `ownership`. `notation plan` then prints `recovers a create that an earlier deploy did not finish`. Plan does not note a create with no `creating` record, although a class with `ownership: "parent"` can take over an existing resource then too.

Deploy takes the resource over in three cases:

1. The record is a `creating` record, the class has `ownership: "token"`, and `find` finds the resource by the token of an earlier execution that the record lists. This runs before `create`, in the step `create:find`, so that a resource whose key the provider assigns, such as an API Gateway API, is not made a second time.
2. The create attempt's outcome was unknown, and its lookup found the resource. The class must have a `read`; otherwise deploy records the create as usual.
3. `create` throws `ResourceAlreadyExistsError`, and the proof holds. With `ownership: "token"`, deploy calls `find` with the token of each earlier execution that a `creating` record lists, and then with the token of the current execution.

In each case:

1. Deploy reads the resource by its key, and checks the read's values. A malformed read fails the deploy and keeps the `creating` record.
2. Deploy writes a `create` record, under `state:persist:<id>:reclaimed`. The record has no `creates`. Its params are the values that the read returned for the params that config sets. A param that the read does not return is left out of the record, so step 3 sees a difference and updates it. If a difference in that param would replace the resource, because the param is immutable or a key, or the class has no `update`, the param keeps its desired value instead. A replace needs a value that the read returned.
3. Deploy compares the record with the desired params, as for any recorded resource, in the scope `reclaimed`, and updates the resource, replaces it, or leaves it as it is. It skips drift detection, because the record was just read. The state writes of this step add `:after-takeover` to their step keys, so they do not reuse the keys of the create that took the resource over. A create that replaces the resource adds `/reclaimed` to the execution ID in its create token and effect IDs. If that create ends in another takeover, step 3 runs again for it, and adds `:after-takeover` and `/reclaimed` once more.

Drift-recreate follows the same rule. When drift detection read a recorded resource as gone, deploy writes a `creating` record that lists only the current execution, because a full record has no `creates`. If `create` then throws `ResourceAlreadyExistsError`, deploy takes the resource over only with the proof:

- `parent`: the proof holds, so deploy takes the resource over.
- `token`: `find` is called with the current execution's token only. The resource that the drift read missed has the token of the execution that made it, which no record names, so deploy fails with `ResourceAlreadyExistsError` and writes the full record back. The next deploy reads the resource again.

When the outcome of a drift-recreate's create is unknown, the `creating` record stays, and lists the execution. The next deploy calls `find` with that execution's token before `create`, and takes over the resource that the create made. If the create made nothing and the drift read was wrong, the resource still has the token of the execution that first made it. The next deploy's `create` then throws `ResourceAlreadyExistsError` and the proof fails, so deploy writes the full record in `recorded` back, and the deploy after it reads the resource again.

The `creating` record of a drift-recreate keeps the recorded output, with the key fields that params supply written over it. A delete of that record then still has a key that the provider assigned; see [Deleting the resource of a creating record](#deleting-the-resource-of-a-creating-record).

When the proof fails, deploy fails with `ResourceAlreadyExistsError`. Deploy then writes back the record that the execution started from; see [The record after a failed create](#the-record-after-a-failed-create). The message says why: the resource's class can't prove which create made a resource, nothing proves that one of Notation's creates made it, or the create was of a replacement.

#### The record after a failed create

Deploy keeps the `creating` record when the outcome is unknown: after `ResourceCreationUnknownError` for a resource with no lookup, or after a `WorkflowEffectError` with code `EFFECT_OUTCOME_UNKNOWN`, when the lookups run out.

After any other error, the create made nothing that deploy may record. This covers `ResourceAlreadyExistsError` without proof, and errors for which `perform` either never ran or made nothing, including another `WorkflowEffectError` code. Deploy then writes back the record that the execution started from, under `state:persist:<id>:restored`:

- When it started from no record, deploy removes the `creating` record.
- When it started from a `creating` record that an earlier execution left, deploy writes that record back. Its `creates` lists the earlier executions and not the current one, so a later deploy can still prove ownership by their tokens. It keeps its `recorded` too.
- When it started from a `creating` record that has `recorded`, and the error is `ResourceAlreadyExistsError` without proof, deploy writes the full record in `recorded` back instead. The resource exists, and no execution that the `creating` record lists made it, so the full record is the only evidence that it is Notation's. The next deploy reads the resource by that record, as it does when the refusal happens in the execution that made the drift read. Any other error says nothing about an existing resource, so the `creating` record is written back, and a later deploy can still take over what an earlier create made.
- When it started from a full record, after a drift read reported the resource gone, deploy writes that record back, so that the next deploy reads the resource again.

A `create` that makes more than one call must throw `ResourceCreationUnknownError` when a call after the first mutating call fails, if what the first call made would otherwise be left without a record. `LambdaLogGroup` does this when its retention policy can't be set. Its lookup then reads the log group by its name, and the takeover sets the retention in the same deploy. The EventBridge rule instead deletes the rule when its targets can't be put. It checks the rule's create token after `PutRule`, before it puts the targets, and refuses a rule without it, which another writer made after create checked for one. It throws `ResourceCreationUnknownError` if the delete fails. `sqs.Queue` checks its create token after `CreateQueue` in the same way.

#### Deleting the resource of a creating record

The orphan sweep and destroy delete the resource of a `creating` record only with the proof:

- `token`: they call `find` with the record's params and the token of each execution that the record lists, in the step `delete:find`. If one finds the resource, they delete it by the key `find` returned, or by the key the record holds. Otherwise they remove only the record, and emit a `skip` lifecycle event with the reason `not-created`.
- `parent`: a class with `find` calls it in the same step, and a `find` that finds nothing gives `not-created`. A class without `find` needs no call. They delete the resource by the key that `find` returned or that the record holds, and a missing resource counts as deleted. The `creating` record of a drift-recreate holds the key that the provider assigned to the recorded resource. When neither holds a key, because the provider assigns it, they remove only the record, and emit `skip` with the reason `key-unknown`.
- No `ownership`: they remove only the record, and emit `skip` with the reason `ownership-unproven`.

A `creating` record that has `recorded` is an exception. When the proof fails, or the class has no `ownership`, the orphan sweep and destroy delete the resource by the key in the output of the full record in `recorded`, as they would have deleted it from that full record. A full record is deleted without proof, and the `creating` record replaced it only because a drift read reported the resource gone. A missing resource counts as deleted. When the proof holds, they delete the resource that it found, and not the one in `recorded`.

A full record that lacks a key field is deleted as usual, so the provider's error stops the deployment.

#### Limits

A resource whose key the provider assigns and whose class has no `ownership: "token"` never reports that it already exists. A new execution creates it again, and the first one is left in the provider.

When the `creating` record names another key than the desired one, for example after config changed the resource's name, deploy creates the resource under the new key. The resource that the abandoned create may have made under the old key is left in the provider, and state does not track it.

When the provider assigns the key, the `creating` record of a drift-recreate can stand for two resources: the recorded one, if the drift read was wrong, and one that the create with an unknown outcome made. A takeover or a delete with the proof handles the second, and the first is left in the provider.

A resource without `ownership` that an abandoned create made is left in the provider. The next deploy refuses it, and the orphan sweep and destroy don't delete it, unless the record was written over a full record.

## Dependency cycles

Resources that depend on each other, directly or through other resources, form a cycle. `orderDeployUnits` (`packages/reconciler/src/cycles.ts`) finds each cycle and picks its placeholders, as described in [Cycles](../reference/resource.md#cycles). Plan, deploy and destroy treat a cycle as one unit in the dependency order: it comes after every resource that one of its members depends on, and before every resource that depends on one of its members. Inside the cycle, the members are ordered by their edges, where a placeholder counts only the edges that don't come from contributions that refer to other members. So a placeholder comes before the members that depend on it.

A member's placeholder params are its params without the contributions that refer to other members of its cycle. Its other contributions stay.

Deploy applies a cycle in passes:

1. The first pass goes through the members in order. A placeholder with no record, or with a `creating` record, is created with its placeholder params, and the decision event has `placeholder: true`. Its record leaves out the edges to the members that its placeholder params leave out, as they may not exist yet. So when deploy fails before it creates them, the orphan sweep can delete the placeholder without an edge to a resource that has no record. The second pass writes the full edges. A placeholder with any other record is left as it is, and its output from state stands in for the members that follow it. This holds when the placeholder must be replaced too: the second pass replaces it. A member that this deploy creates is then created with the output of the old resource, and updated after the replace, which is one more update than a create after the replace would need. With drift detection, deploy first reads a placeholder that has a record, and when it no longer exists, creates it with its placeholder params, with the decision **drift-recreate**. Every other member is reconciled as usual, so it sees the placeholder's output.
2. Each later pass reconciles every member with its full params, in the same order. A placeholder is updated with its contributions in the second pass. A member whose params changed, because the output of another member changed, is updated again.
3. Deploy stops after a pass in which no member's output changed, and after which no member lacks contributions because of a replacement, as the next pass would change nothing. A member lacks contributions when a replacement created it without some of them, and the pass has not reconciled the member since.

A cycle of N members gets at most N passes after the first, and at least two, so that a member that refers to itself is updated with its contributions in one pass and checked in the next. Each replace of a member adds a pass, as the replacement is created again. If an output still changes in the last pass, deploy fails with `ResourceCycleError`, which names the outputs that changed in it, such as `a.version`. This happens when a member takes an output that changes on every update, such as a version ID.

After the first pass, a pass announces a decision only when it is not **noop**, except the second pass for a placeholder. Drift detection reads each member once, in the first pass. A placeholder with a record is read in the first pass to find out whether it still exists, with the step keys `notation:deploy:<id>:placeholder:check`. The second pass decides its drift from that read, when its full params match its record. A placeholder that this deploy created is not checked for drift. Each pass has its own step keys, `notation:deploy:<id>:settle:<n>`, and its own state write keys, such as `state:persist:<id>:settle:<n>`. The first pass for a placeholder uses `notation:deploy:<id>:placeholder`.

When deploy fails after it created a placeholder, the placeholder has a record. The next deploy leaves it as it is in the first pass, and updates it in the second.

A pass after the first must not create or replace a member that this deploy has already created. A second create would reuse the create effect IDs of the first. This happens when a param of a member that forces a replacement takes an output of another member, and that output changed when the other member was updated with its contributions. It also happens when deploy replaces a member, and deletes a member that this deploy created because it blocks the delete. Deploy fails with `ResourceCycleError` in both cases, and the error says which. In the second case, the next deploy creates the deleted member.

### Replacing a member of a cycle

Deploy replaces a member of a cycle as it replaces any resource: it deletes the dependents that block the delete, deletes the member, and creates it again. The other members still refer to the member when it is deleted. A provider may refuse to delete a resource that another resource refers to. Cloudflare, for example, does not delete a Worker that another Worker binds, unless the delete is forced. So the provider must delete the member while a dependent in the deployment refers to it. See [Deletes of a resource that others refer to](#deletes-of-a-resource-that-others-refer-to).

The members that refer to the replaced member are updated with the output of the new resource when deploy reaches them: later in the same pass, or in the next pass. Until then, their references point at a resource that no longer exists. The replaced member is unavailable from its delete until its cycle settles.

A replaced member is created without some of its contributions in two cases, and the next pass updates it with them:

- It refers to itself through its contributions. They hold the output of the resource that was deleted.
- It refers through its contributions to a member that the replacement deleted as a dependent that blocks the delete. That member exists again only when deploy reaches it.

The same holds for a member that deploy replaces after it took the resource over in the same deploy; see [Taking a resource over](#taking-a-resource-over). That replace does not add a pass.

The removal of each dependent's record has the state write key `state:delete:<dependent id>:replace:<replaced id>`.

A member that depends on the replaced member is updated only when its params change. This holds when it takes an output that the replacement changes, such as the name. Deploy does not update a member whose params stay the same, so a provider whose references break for good when the target is deleted, even when a resource with the same name is created again, must make a replacement change an output that the dependents take. A Worker is replaced only when its name changes, and the Workers that bind it take its name.

Plan plans each member that comes before a replaced member a second time, after the replaced member, so that its node shows the update with the unknown output of the replacement, not a **noop** against the output of the old resource.

Notation has no names that let the old and the new resource exist side by side, so deploy can't create the new resource before it deletes the old one.

### Destroying a cycle

Destroy deletes the members of a cycle in the reverse of their order in deploy. A placeholder comes first in deploy, so it is deleted last, and it still refers to the members that are deleted before it. As in a replace, the provider must delete a resource that a dependent in the deployment refers to. Destroy does not read the current code for this, so a change to the code since the last deploy does not stop it.

The orphan sweep deletes orphans that form a cycle in storage order, and relies on the provider in the same way. This covers the ordinary case of removing two Workers that bind each other from code.

### Deletes of a resource that others refer to

A type that sets `deleteTakesDependents` gets a fourth argument in `delete`: `{ dependents }`, the resources whose state records depend on the deleted resource, each with its `id`, `type` and the `params` in its record. Deploy lists state just before the delete, in the step `dependents` of the delete's scope, so the list leaves out the dependents that it has already deleted. A dry run does not list state.

Deploy updates or deletes every dependent in the same run:

- In a replace, each dependent is a resource in code that deploy updates when it reaches it, or an orphan that the sweep deletes.
- In destroy and in the orphan sweep, each dependent is deleted too.

So a provider can force a delete that it would otherwise refuse, when every reference to the resource comes from one of the dependents. It must refuse when another resource refers to it, such as a resource of another deployment, as nothing repairs that reference.

`WorkerScript` does this. Cloudflare refuses the delete of a Worker that another Worker binds as a service (code 10142), or whose Durable Object namespace another Worker binds (code 10064). On either refusal, the delete reads the Worker's references and the Workers that send it tail events. When every one of them is a `WorkerScript` among the dependents, it deletes the Worker with `force=true`. Otherwise it fails, and the error names the Workers that the deployment does not manage. A reference from a Pages project fails in the same way. A forced delete leaves the bindings to the Worker broken until each Worker that holds one is uploaded again.

When deploy fails between a forced delete and the update of a dependent, the dependent keeps its broken reference. The next deploy creates the resource if it is missing, and updates the dependent.

### Plan

Plan loads the output of every member of a cycle from state before it plans the first member. A member that depends on a member with no record plans the value as unknown, as for any resource. Each member's node has `cycle`, the IDs of the other members. A placeholder that deploy creates has `placeholder: true`, and `notation plan` prints:

```
+ create cloudflare/workers/WorkerScript worker:api
    created first without the contributions that refer to worker:reports, the other members of its cycle
```

The node shows the full params, not the placeholder params.

A dry run of a cycle runs only the first pass, as it creates and updates nothing that a later pass could see. It then reconciles each placeholder that has a record with its full params, under the step keys of the second pass, so that it reports the update that deploy would make. A dry run of a new cycle fails in the first pass when a member reads an output of a placeholder that does not exist yet, as a dry run of any new chain of resources does.

## Dependency check

Before plan or deploy does anything else, `assertDependenciesPresent` (`packages/reconciler/src/dependency-graph.ts`) checks every dependency of every resource. A resource gets dependencies in four ways:

- declared in its `dependencies`
- added with `dependOn`
- held as an output ref in its config or contributions
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

**Output refs.** Plan fills in each output ref from the outputs in state. When the resource has no output yet, plan marks the value unknown at its own path, and the rest of the map stays visible.

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

Orphans that form a cycle cannot be ordered. They, and the orphans that depend on them, are deleted first, in storage order. A provider that refuses to delete a resource that another orphan refers to fails the deploy, unless its type forces the delete; see [Deletes of a resource that others refer to](#deletes-of-a-resource-that-others-refer-to). An orphan in this group with no registered class does not keep the orphans it depends on in the group, as the sweep can delete them before it reaches the orphan.

The sweep looks up an orphan's class by its type in the caller's `registry`, merged with the classes of the resources in the graph. Each state record stores the provider of its resource in `provider`, a package name or a package subpath, which the resource class declares with `resource({ type, provider })`. `deployApp` and `destroyApp` in `@notation/core` collect the providers that state names, in a `notation:providers` step, and pass the resource classes that each provider exports. Only the records whose type has no class in the graph count, as the graph's classes cover the others. Each provider is resolved with `createRequire` from the project root, and then imported. A provider package is not always a direct dependency of the project, and pnpm does not link a transitive package into the project's `node_modules`. So a package that the root can't resolve is resolved from the real directory of each package in the project's dependency tree, breadth first, starting from the nearest `package.json` at or above the root, as Node resolves it when that package imports it. The walk stops at the first directory that resolves the package. If the tree holds two versions of a package, the first one found is loaded. A package is skipped, and a `reconciler.provider.load-failed` warning names it with the cause, when it can't be resolved, resolves to a builtin module such as `fs`, throws on import, or exports no resource classes that declare it as their provider. The loader takes the resource classes among the module's exports and among the values of each exported object, so a namespace export such as `lambda` is read. It reads `default` in the same way, because `import()` puts a CommonJS module's exports there. Other exports are ignored. A class whose `provider` is another package is ignored too, so each type is loaded only from the provider that its state record names. A provider name may contain only letters, digits, `_`, `.`, `~` and `-`, with an optional leading `@` and `/` between segments, and no segment may start with a dot. A record whose provider is not such a name, such as a relative path, an absolute path or a Windows drive path, is skipped in the same way. A record with no `provider` was written by an earlier version, and plan, deploy and destroy fail on it at the start. Deploy and destroy emit the warning in a step under `notation:providers:<package>`, so a resumed execution does not emit it again. The sweep's `reconciler.orphan-deletion.skipped` warning still names each record that is left in place. Core does not list the provider packages, so a provider from outside this repository works the same way. `planApp` loads the same packages without a step, so plan finds the same blocking dependents as deploy. Without these classes, a record whose type no longer appears in the graph could not be deleted. The packages are read before the deployment hold. So when an execution waits on another's hold, it does not have the packages of the records that the other execution writes, and its sweep skips those records as orphans until the next deploy.

When an orphan's type has no registered class, the sweep keeps the orphan and every orphan it depends on, directly or through another orphan. In destroy, it also keeps every resource in the desired set that the orphan depends on, directly or through another kept resource, and destroy does not delete those resources. The `reconciler.orphan-deletion.skipped` warning names the kept resources in `keptDependencies`. Each orphan with no registered class emits its own warning, including an orphan that another skipped orphan already keeps.

Dry-run deploy performs decisions and emits lifecycle events without provider mutations or state mutations. When drift detection is enabled, it can still call provider read operations to decide whether a nominal noop has drifted.

## Destroy flow

`destroy` is a first-class durable operation. It takes the same deployment hold as deploy, deletes registered persisted orphans, deletes desired resources in reverse dependency order, and conditionally removes each resource store only after the provider delete succeeds or reports that the resource is already absent. Orphans go first, because an orphan can depend on a desired resource, but no desired resource depends on an orphan.

## Waiting and replay

Provider calls are stable durable steps, but provider acknowledgement and the `@notation/durable` heap checkpoint are not atomic. If the process crashes between them, replay repeats an update or delete call, so those operations must be idempotent. Each create attempt runs as a `@notation/durable` `step.effect`. After a crash, the reconciler looks the resource up before it calls create again, when the resource can be found; see [Unknown create outcomes](../reference/resource.md#unknown-create-outcomes). Event subscribers must likewise tolerate duplicate delivery when a crash occurs before the event checkpoint.

A resource operation throws `ResourceOperationPendingError` when it has not finished. The error gives the reconciler a delay and optional callback context. The runtime stores the context, waits without keeping the process busy, and calls the same operation again. From `create`, `update` or `delete`, the error means that the call made no change and can be made again, for example while an IAM role propagates. From `read`, it means that the resource exists and has not reached a stable state, so calling `read` again polls it. A `throttled` error from `read` means only that the provider refused the request because of a rate limit. See [Operation errors](../reference/resource.md#operation-errors) for the complete API.

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
