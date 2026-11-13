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
| A retired instance in a state record                                                     | **delete-retired** |
| In state with another type                                                               | plan fails         |

The change decision comes from the resource schema, through `diffParams` in `@notation/resource`. It compares comparable params (`param` items that are not `volatile` or `hidden`) field by field. A changed field forces replacement when its schema item is `immutable`, `primaryKey` or `secondaryKey`, or when the resource has no `update` operation. A change anywhere inside such a field replaces the whole resource. If the changed field's schema item has `rejectReplace`, and the new value is known, plan and deploy fail with its message instead.

After the diff, `decideAction` calls the resource's [`rejectChange`](../reference/resource.md#rejecting-a-change), if it has one and a state record, with the params in state, the params in code, and whether the diff replaces the resource. The planner calls it again with `replace: true` for a resource that is replaced only because a replaced dependency's delete needs it deleted first, and deploy does the same for each such dependent before it deletes any of them. The planner and deploy's first check call `assertOrphanDeleteAllowed` for each orphan that the sweep deletes, which calls the `rejectChange` of the orphan's class with no desired params. They find these orphans with `orphanSweepSteps`, as the sweep does, so they skip an orphan that an orphan with no registered class keeps in place. The orphan sweep repeats the check under the deployment hold. A message fails plan or deploy. Deploy's first check runs before the deployment hold, so a change that it rejects fails before any resource changes.

An `undefined` param counts as absent, so an optional param left unset never looks changed. Drift compares only fields that both the desired params and the read output have: a read need not return every param, and it reports defaults for params left unset, and neither is drift.

A replace runs in one of two orders, which `replaceOrder` in `packages/reconciler/src/physical-names.ts` picks from the class. A class with a `physicalName` param is replaced create-first: deploy creates the replacement under a new name beside the old resource, and deletes the old resource at the end of the deploy. See [Create-first replacement](#create-first-replacement). Every other class is replaced delete-first.

A delete-first replace deletes the resource and then creates it again. A resource whose key does not change with the replace, such as a `LambdaEventSourceMapping`, whose key is its function and event source, keeps the key, so a new resource created beside the old one would collide with it. Each half is durable: the delete removes the state record, and the create writes a new one with a new instance ID. A crash anywhere in between resumes where it stopped. If the create fails, the old resource and its record are gone, and the next deploy plans **create**. There is one exception. When a resource already exists and deploy refuses it or cannot take it over, deploy writes the record of the replaced resource back, and the next deploy plans **replace** again. See [Guard 1](#guard-1-a-replacement-does-not-take-over-a-resource-with-the-replaced-key) and [The record after a failed create](#the-record-after-a-failed-create).

The dependents of a replaced resource stay in place. When deploy reaches each of them, it decides again with the outputs of the new resource. A dependent whose params change is updated, or replaced if a changed param forces replacement. For example, replacing a Lambda role updates the function's `Role`, and does not delete the function or its log group. In a delete-first replace, a dependent whose type blocks the delete of the replaced resource is deleted first instead. See [Dependents of a replaced resource](#dependents-of-a-replaced-resource).

An unknown immutable or key param plans **replace** with the field marked "unknown, may force replacement". The planner treats a replaced resource's output as unknown, so its dependents plan against unknown params, and can show **replace** in turn. Deploy decides again for each resource once its dependencies have converged, with real params, so it replaces only what really changed. [Unknown values](#unknown-values) explains when plan marks a param unknown.

A resource can't change type under the same ID, as its class would read, update or delete the resource of another class. When a state record's type differs from the type of the resource with its ID, plan and deploy throw `ResourceTypeChangedError` before any change. Destroy deletes such a record through the class of the record's type instead, so destroy does not need code to agree with state. When that class is not registered, destroy keeps the record and every resource it depends on, and emits `reconciler.orphan-deletion.skipped`. A provider that changes the type of a resource gives it a new ID instead. The new resource is then created in the dependency walk, and the old record is deleted in the orphan sweep after the walk, so the new resource exists before the old one is deleted. The old type's class must stay registered for the sweep to delete it.

### Dependents of a replaced resource

This section applies to a delete-first replace. A create-first replace deletes no dependent in advance; see [Create-first replacement](#create-first-replacement). In `@notation/aws/resources`, `EventBridgeRule` lists `EventBus`, but a bus is replaced create-first. So the steps below run for no class in Notation's provider packages today. The examples show what they would do if a bus were replaced delete-first.

A provider can refuse to delete a resource while other resources use it. For example, AWS does not delete an EventBridge bus that has rules. The type of the dependent lists the types it blocks the delete of, in its definition:

```ts
const eventBridgeRule = resource<EventBridgeRuleSchema>({
  type: "aws/eventBridge/rule",
  blocksDeleteOf: [EventBus.type],
});
```

Set `blocksDeleteOf` only when the provider refuses to delete a resource of the listed type while a resource of this type depends on it. Each dependent it applies to is deleted and created again, and is gone in between. When importing the class would make an import cycle, write the type as a string literal. Nothing checks that a listed type exists, so a mistyped type is ignored. The resource class exposes the list as `blocksDeleteOf`, as it exposes `type`. In `@notation/aws/resources`, only `EventBridgeRule` sets it. It does not list `DefaultEventBus`, which is never deleted.

A dependent blocks the delete of a resource when it depends directly on the resource, and its class lists the type of the resource in `blocksDeleteOf`. A record whose [retired instance](#create-first-replacement) depends directly on the resource counts as a dependent too, and is deleted with its retired instances. A dependent that reaches the resource only through a resource that does not block its delete is not deleted. When deploy replaces a resource, it runs these steps:

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

### Create-first replacement

A class with a `physicalName` param is replaced create-first. Its replacement gets a new generated name, so it can exist beside the resource that it replaces. In `@notation/aws/resources` these are the Lambda function, the function's IAM role, the SQS queue, the EventBridge rule and bus, and the API Gateway API. In `@notation/cloudflare` it is the Worker. A drift-replace of such a class creates first too. Deploy runs these steps:

1. Deploy generates the new names and writes the `creating` record of the replacement. In the same write, it adds the old resource to the record's `retired` list. The resource is now retired.
2. Deploy creates the replacement and writes its `create` record. The resource ID now refers to the replacement.
3. Deploy carries on through the graph. It decides each dependent again with the outputs of the replacement, and updates or replaces it.
4. After the last resource in the graph, the sweep deletes each retired instance, together with the orphans, in reverse order of their edges. Each delete removes the instance from its record's list.

Each entry of the `retired` list holds the `config`, `params`, `output` and `dependsOn` of the old resource, and `retiredAt`, the time when the replace started. A record lists several instances when a second replace runs before the first old resource is deleted. See [State](./state.md). Three rules keep the list correct:

- Every write to the record keeps the list.
- A record that lists retired instances is not removed. Deploy and destroy delete a record's retired instances just before the record.
- When a create fails with a known outcome, deploy writes back the record of the old resource, with its list as it was before the replace.

No dependent is deleted in advance. A dependent whose type blocks the delete of the replaced resource has a param that holds an output of the replacement, so deploy updates or replaces it when it reaches it. For example, when a bus is replaced, each rule on it gets a new `EventBusName`, which is immutable. The rule is replaced create-first too, and the sweep deletes the old rule before the old bus. A dependent with no `physicalName` param, such as a Lambda permission, is replaced delete-first when deploy reaches it. By then its dependency's replacement exists.

The old resource and its replacement have the same ID, so an edge in state can't say which of the two a dependent uses. The sweep decides by whether the dependent is in code:

- A dependent in code has been decided again in step 3, so the sweep treats it as using the replacement. Its edges do not order the sweep.
- A dependent that is no longer in code was not decided again, so it uses the old resource. The sweep deletes it before the retired instance.

The sweep reaches a record in code only to delete its retired instances, under the step keys `notation:retired:<id>`. Destroy deletes the retired instances under the step keys of the record. The delete of a record's instance `<n>`, oldest first, runs in the scope `retired:<n>`, and its state write has the key `state:persist:<id>:retired:<n>`. Each delete event has `reason: "retired"`.

When the provider refuses to delete a retired instance, the deploy fails. The instance stays retired, and the error names the resources in code that depend on the resource. In destroy, the error does not name them, as destroy has deleted every resource that depends on the record already, except the other members of its cycle. Any other error, such as a `VersionConflict` from the state write, fails the deploy unchanged. The next deploy deletes the instance in its sweep, whether or not it replaces anything. It does not delete it at its start, because a dependent that a stopped deploy did not reach still uses the old resource.

A deploy that stops after the create leaves the old resource retired, and the next deploy deletes it at its end. When the create has an unknown outcome, the `creating` record keeps the old resource in its list, and the next deploy resolves the create as described in [Recoverable creates](#recoverable-creates).

A dry run emits a **dry-run** delete with `reason: "retired"` just after the create of the replacement, and changes nothing.

A class that loses its `physicalName` param is replaced delete-first. Deploy then deletes the retired instances that the record lists before it deletes the resource. A dependent that a delete-first replace deletes because it blocks the delete is deleted with its retired instances too. See [Dependents of a replaced resource](#dependents-of-a-replaced-resource).

Plan sets `replaceOrder` on each node with the decision **replace** or **drift-replace**. A dependent that plan shows as **replace** only because a replaced dependency's delete needs it deleted first has `replaceOrder: "delete-first"`. For each retired instance that the sweep deletes, plan adds a node with the decision **delete-retired**, the ID of its record, `retiredIndex`, the instance's position in the record's list, the instance's `params` and `dependsOn`, and `retiredAt`. The ID and `retiredIndex` together name the instance. Plan lists them in the order of the sweep. Plan leaves out the retired instances of a record that the sweep keeps, because an orphan with no registered class depends on it. When plan shows a record as a delete-first **replace**, it lists the record's retired instances just before that node, as deploy deletes them with the resource. `notation plan` prints the order after a replace, and each retired instance as a delete:

```
+/- replace aws/lambda/LambdaIamRole lambda:orders:role (create, then delete)
- delete-retired aws/lambda/LambdaIamRole lambda:orders:role
    the instance that a replace retired at 2026-11-13T09:12:44.120Z, deleted at the end of the deploy
```

Limits:

- Two instances of a resource exist for part of a deploy, so a replace can fail on an account quota that it passed before.
- A resource that holds data, such as an SQS queue, still loses its data when it is replaced. The old queue is deleted at the end of the deploy, not at the start.
- A dependent in code that holds its link to the old resource in a `hidden` or `volatile` param, or in no param, is not updated. The provider then refuses the delete of the retired instance, and every deploy fails until the dependent changes. No class has such a dependent today.
- A delete-first replace, and the delete of a dependent that blocks it, delete the record's retired instances when deploy reaches the record, not at the end of the deploy. A dependent that a stopped deploy did not reach can still use one of them. This happens only for a class that has lost its `physicalName` param, or for a dependent that blocks the delete of a resource that is replaced delete-first.
- A class can have a unique value besides its name. If the replacement collides on it, the create fails. No class with a `physicalName` param has such a value today, so a class can't turn create-first off.

### Recoverable creates

A deploy can stop after the provider made a resource and before deploy recorded it. The next deploy then finds the resource in the provider, and takes it over instead of failing.

Before deploy calls a resource's `create`, it writes a `creating` state record, under the step key `state:persist:<id>:creating`. The record holds the resource's config, params and dependency edges. The params include each physical name that deploy generated. Its output holds the key fields that params supply. When the create is done, deploy replaces the record with a `create` record. A `creating` record that is still in state says that a deploy tried to create the resource, and may or may not have made it. Plan and deploy decide **create** for it.

#### Generated names

A param whose schema item has `physicalName` holds the resource's physical name. The reconciler owns this param: it generates the value from the resource ID, and config cannot set it. See [Physical names](../reference/resource.md#physical-names). Deploy resolves a resource's params in the step `params`, and then fills in each `physicalName` param, before it decides the action:

1. If the resolved params hold a value for the param, `deriveParams` or untyped config supplied it, and deploy throws.
2. If the params of the state record hold the name, deploy uses that name. A `creating` record counts.
3. Otherwise deploy generates a name, in the step `physical-names`, so that a replay of the execution gets the same name.

A ref from the resource to one of its own `physicalName` params is not a dependency. `getParams` leaves it as an `OwnPhysicalName`, `{ "~physicalName": "<param>" }`, which the step `params` can record. `fillPhysicalNames` in `packages/resource/src/physical-name.ts` then sets each name and replaces each `OwnPhysicalName` with the name of its param. A replace fills in the new names in the same way, from the params before the old names were filled in.

`generatedPhysicalName` in `packages/resource/src/physical-name.ts` makes the name, `<app>--<stage>--<base>-<instance>`:

| Part       | Value                                                                                                                                                                                                                                                |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app`      | From `nameScope`, a required option of `deploy`. `deployApp` in `@notation/core` passes the app and the stage of the deployment.                                                                                                                     |
| `stage`    | From `nameScope` too.                                                                                                                                                                                                                                |
| `base`     | The result of the rule's `base` for the resource ID, or the whole resource ID when the rule has no `base`. It is put in lower case, each run of characters other than `a-z` and `0-9` becomes one `-`, and a `-` at the start or the end is removed. |
| `instance` | 8 hex characters, from 4 random bytes.                                                                                                                                                                                                               |
| ending     | The result of the rule's `ending` for the resolved params, after the instance. The name has no ending when the rule has no `ending`.                                                                                                                 |

The reconciler does not read the parts of a resource ID. The provider package decides the base, because it decides the shape of its resource IDs. The rules of `@notation/aws` have a `base` that removes the type prefix, so the queue `sqs-queue:orders` of app `my-app` in stage `prod` gets `my-app--prod--orders-1a2b3c4d`, or `my-app--prod--orders-1a2b3c4d.fifo` when its `FifoQueue` is `true`. A rule with no `base` gives `my-app--prod--sqs-queue-orders-1a2b3c4d`.

When the name is longer than the rule's `maxLength`, `<app>--<stage>--<base>` is cut to fit, hyphens at its end are removed, and the instance and the ending stay whole.

From here on the name is one of the resource's params. Deploy validates it, writes it in the `creating` record, and passes it to `create`. **The name is in state before the provider is called.** This matters because it means that a deploy that stops during the create leaves the name behind: the next deploy takes the name from the `creating` record in step 2, and looks for the resource under the same name.

A replace generates the names again, for every `physicalName` param, in the step `physical-names` of the scope `replace:create`. So a replacement never gets the name of the resource that it replaces, and it can exist beside it. A replace of such a class creates first; see [Create-first replacement](#create-first-replacement).

Plan fills in the same params without generating anything. It throws in the same way when the params supply the param. It takes the name from the state record when the record has one, and marks the name unknown otherwise. For a resource that plan decides to replace, plan marks the name unknown in the node's `params`. A ref to the resource's own name gets the same value as the name.

#### The takeover rule

When `create` throws `ResourceAlreadyExistsError`, deploy takes the existing resource over. This holds for every resource class.

The reason is the resource's name. Deploy generates every AWS and Cloudflare name that Notation makes: `<app>--<stage>--<base>-<instance>`, with a random instance. No other deployment has the name, and nobody can type it in advance, so a resource in the provider with that key was made by this deployment. A resource whose key holds no generated name, such as a mapping's function and event source, is under a parent that is in state, and so belongs to the same deployment. Deploy does not check who made the resource. If a resource with that key was made outside Notation, deploy takes it over too, and then updates or replaces it to match config.

Deploy output prints a line for each takeover:

```
Took over lambda:todos:role: it already existed, so deploy read it and now compares it with config
```

The line follows the `create` lifecycle event that reports the success, which has the reason `taken-over`.

#### Taking a resource over

There are three ways to a takeover:

1. The class has a `find`. Deploy calls `find` before every `create` of such a class, in the step `create:find`, and takes over the resource that `find` returns. It does this whatever the record is: no record, a `creating` record, or the record of a resource that a drift read reported as gone. This stops deploy from making a second resource when the provider assigns the key, such as an API Gateway API. When `find` throws `ResourceNotFoundError`, deploy writes the `creating` record and calls `create`. When `find` throws another error, the deploy fails, and the record stays as it was.
2. The outcome of a create attempt was unknown, and its lookup found the resource. See [Unknown create outcomes](../reference/resource.md#unknown-create-outcomes).
3. `create` throws `ResourceAlreadyExistsError`. A class with `find` gets the resource's key from `find`, in the step `create:existing`. Any other class has its whole key in params.

`notation plan` prints `recovers a create that an earlier deploy did not finish` under the create of a resource that has a `creating` record, and the plan node has `mayTakeOver: true`. Plan does not note a create with no record, although that create can end in a takeover in the first or the third way.

A drift-recreate is a create too. When a drift read reported a recorded resource as gone, and `create` then reports that it exists, deploy takes it over.

In each case, deploy does three things:

1. It reads the resource by its key, in the scope `create:takeover`. If the read fails, the deploy fails, and the record stays as it was. In the first way that is the record that the create started from, because deploy has not written a `creating` record yet. In the other two ways it is the `creating` record.
2. It writes a `create` record, under `state:persist:<id>:taken-over`. The record's params are the values that the read returned for the desired params.
3. It compares the record with the desired params, as for any recorded resource, and updates the resource, replaces it, or leaves it as it is. It skips drift detection, because the record was just read.

The read need not return every param. Step 2 handles a param that the read did not return in one of two ways:

- The param is left out of the record. Step 3 then sees a difference and updates the param.
- If a difference in the param would replace the resource, the param is recorded with its desired value, so step 3 sees no difference. This applies to an immutable param, a key param, and every param of a class with no `update`. Deploy replaces a resource only for a difference that the read returned.

Step 3 runs in the scope `taken-over`, and its state writes add `:after-takeover` to their step keys, so they do not reuse the keys of the create that took the resource over. A create that replaces the resource in step 3 adds `/taken-over` to the execution ID in its effect IDs. If that create ends in another takeover, step 3 runs again, and adds `:after-takeover` and `/taken-over` once more.

#### Guard 1: a replacement does not take over a resource with the replaced key

A delete-first replace deletes the resource and creates it again. The replacement has the same key when its key does not change with the replace: config provides the key, or the key holds no name of the resource's own, such as the function and event source of a `LambdaEventSourceMapping`. If the provider still holds the deleted resource when the create runs, a takeover would record the old resource as its own replacement.

So the create of a delete-first replacement compares the key of an existing resource with the key in the record of the replaced resource. When the keys are equal, deploy refuses the resource: it writes the record of the replaced resource back, and fails. The next deploy deletes the resource and creates the replacement again.

The rule is the same on all three ways to an existing resource in that create:

- `find` returns the resource before `create` is called. No create has run, so the existing resource is the replaced one. This happens when the provider's list still returns a resource after its delete. `find` should leave out a resource that the provider reports as being deleted. `LambdaEventSourceMapping`'s `find` leaves out a mapping in the state `Deleting`.
- `create` throws `ResourceAlreadyExistsError`. The create made nothing, so the existing resource is the replaced one.
- The lookup of a create with an unknown outcome finds the resource. The resource is the replaced one or the replacement, and deploy cannot tell which. If it is the replacement, the next deploy replaces it once more.

When the replacement has another key than the replaced resource, for example after a change of name, the existing resource is not the replaced one, and deploy takes it over as usual. A replacement with a generated name has a new name, so it cannot meet the resource that it replaces. Such a replacement is created first, while the resource that it replaces still exists, and the guard does not apply to its create.

The guard applies only to the create of the replaced resource, inside a delete-first replace. It does not apply in two other cases; see [Limits](#limits):

- A later deploy creates the resource from a `creating` record or from no record.
- A replace deleted a dependent because it blocks the delete. Deploy creates that dependent again later in the same deploy, with a plain create. That create does not know the key of the deleted dependent.

#### Guard 2: no takeover by an attribute that is not unique

When the provider assigns a resource's key, deploy can find the resource only by another attribute, such as its name. Deploy takes a resource over only when that attribute picks out one resource:

- `find` must fail when several resources match. API Gateway does not keep an API's name unique, so `Api`'s `find` lists every API with the name and throws an error that names them. `RouteAuth` and `LambdaEventSourceMapping` do the same, through `findOnlyInPages` in `packages/aws/src/resources/utils/paginate.ts`. The deploy fails until all but one are deleted.
- When `create` throws `ResourceAlreadyExistsError`, and the class has a key that the provider assigns and no `find`, deploy fails the create. It also fails the create when `find` finds no resource. The message says that deploy cannot take over the existing resource, and why.

#### The record after a failed create

When `find` fails before the create, in the step `create:find`, deploy has not written a `creating` record. The record stays as it was, so a `creating` record that an earlier deploy left stays.

Deploy keeps the `creating` record that it wrote when the outcome of the create is unknown: after `ResourceCreationUnknownError` for a resource with no lookup, or after a `WorkflowEffectError` with code `EFFECT_OUTCOME_UNKNOWN`, when the lookups run out. It also keeps the record when the read of a takeover fails.

After any other error, the outcome is known: the create made nothing, or the resource exists and deploy cannot take it over. Deploy then writes back the record that the create started from, under `state:persist:<id>:restored`:

- When the create started from no record, deploy removes the `creating` record.
- When it started from a `creating` record that an earlier deploy left, deploy writes that record back.
- When it started from a `create` or `update` record, in a drift-recreate, deploy writes that record back. The next deploy reads the resource again.

The create of a create-first replacement starts from the record of the replaced resource. After any error with a known outcome, deploy writes that record back, with the retired instances that it listed before the replace. Nothing was deleted, so the next deploy replaces the resource again. After an unknown outcome, the `creating` record stays, and still lists the replaced resource as retired.

The create of a delete-first replacement starts from no record, because the delete removed it. It removes the `creating` record when `create` fails with an error of its own. It writes back the record of the replaced resource instead in these cases, so that the next deploy replaces the resource again:

- Guard 1 fails the create.
- `create` throws `ResourceAlreadyExistsError`, and deploy cannot take the existing resource over. See the cases below.

Deploy cannot take an existing resource over in these cases. In each, the outcome is known, and no `creating` record is left:

- `create` throws `ResourceAlreadyExistsError`, and `find` then throws an error other than `ResourceNotFoundError`, for example because several resources match.
- `create` throws `ResourceAlreadyExistsError`, and `find` finds no resource, or the provider assigns the key and the class has no `find`.
- The class has no `read`, and `create` throws `ResourceAlreadyExistsError`, or the lookup of a create with an unknown outcome finds the resource.

A `create` that makes more than one call must throw `ResourceCreationUnknownError` when a call after the first mutating call fails, if the first call's resource would otherwise have no record. `LambdaLogGroup` does this when its retention policy can't be set. Its lookup then reads the log group by its name, and the takeover sets the retention in the same deploy. The EventBridge rule instead deletes the rule when its targets can't be put, and throws `ResourceCreationUnknownError` only if that delete fails.

#### Deleting the resource of a creating record

The orphan sweep and destroy handle a `creating` record like this:

1. A class with `find` calls it with the record's params, in the step `delete:find`. When `find` throws `ResourceNotFoundError`, the create made nothing. Deploy removes only the record, and emits a `skip` lifecycle event with the reason `not-created`.
2. Any other class uses the key in the record's output.
3. If a key field is still missing, because the provider assigns it and the class has no `find`, deploy removes only the record, and emits `skip` with the reason `key-unknown`.
4. Otherwise deploy deletes the resource by its key. A missing resource counts as deleted.

#### Limits

- A class with a key that the provider assigns and no `find`, such as `LambdaIntegration`, can't be looked up. When a deploy stops after the provider made the resource and before deploy recorded its key, the next deploy creates a second one. The first stays in the provider, and state does not track it. A delete of the `creating` record removes only the record.
- A takeover of a class with no `read` fails, because deploy cannot compare the resource's params with config. `LambdaRolePolicyAttachment` is the only such class in `@notation/aws`, and its `create` never throws `ResourceAlreadyExistsError`. The error says how to get past it: delete the existing resource and deploy again.
- When the `creating` record names another key than the desired one, for example after config changed a mapping's event source, deploy creates the resource under the new key. The resource that the unfinished create may have made under the old key stays in the provider, and state does not track it.
- Deploy relies on the provider's "already exists" error, or on a check that `create` makes before its call. A provider whose reads are eventually consistent can report a resource as absent just after another create made it. `create` then makes a second resource when the provider does not keep the name unique, and a later `find` fails because two resources match.
- A `creating` record does not say that its create was the create of a replacement. So guard 1 does not apply on the next deploy in two cases: the create of a replacement ended with an unknown outcome and left its `creating` record, or a delete-first replace stopped between its delete and its create. The next deploy plans a plain **create**, and takes over an existing resource as usual. It keeps the replaced resource as the replacement only when all of these hold: no create made the replacement, the provider reported the delete as done while the resource is still visible, and the read does not return the param that forced the replace. Deploy then records that param with its desired value, and the resource keeps the old value.
- Guard 1 does not cover a dependent that a replace deleted because it blocks the delete. Deploy creates the dependent again later in the same deploy, with a plain create. If the provider still returns the deleted dependent then, deploy takes it over, and the record then describes a resource that the provider is deleting. The record of the deleted dependent is not passed to that create, because the create runs when deploy reaches the dependent, in another part of the workflow.
- `find` runs before every create of a class with `find`. When the provider's list returns a deleted resource for a while, a delete-first replace of such a class fails through guard 1, and the next deploy replaces the resource again.
- A takeover updates or replaces the existing resource to match config. Two deployments with the same app and stage in one provider account therefore write over each other's resources, where both compute the same key. A generated name differs on each create, so this applies only to a key that holds no generated name.
- A generated name is only in the state record. When the record of a resource with a generated name is lost, the next deploy generates a new name and creates a second resource. The first stays in the provider, and state does not track it. A deploy that stops during the create is the exception, because it leaves the `creating` record with the name. For a Cloudflare Worker that hosts a Durable Object namespace, see [Moving a namespace](../providers/cloudflare/workers.md#moving-a-namespace): deploy fails when a namespace may still be on a Worker whose record was lost.
- The cut of a long generated name removes the base first. A name of at most 64 characters, such as a Lambda function's, has 55 characters before `-<instance>`, and `<app>--<stage>--` takes 4 more than the app and the stage. So the base is cut when the app, the stage and the base together have more than 51 characters. With an app and a stage of 32 characters each, `<app>--<stage>--` has 68 characters, so the name holds the app, a part of the stage and the instance. Such names differ only in the instance.
- The ending of a generated name is decided when the name is generated. When the create of a queue ends with an unknown outcome, and `fifo` is then turned on, the `creating` record keeps a name without `.fifo`. Deploy uses that name with `FifoQueue: true`, and fails until `fifo` is turned off again.
- The plan of a replace shows a generated name as unknown in the node's `params`, but the node's `diff` and `replaceFields` do not list the name, because plan compares the params before it marks the name unknown.

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

A pass after the first must not create or replace a member that this deploy has already created. A second create would reuse the create effect IDs of the first. This happens when a param of a member that forces a replacement takes an output of another member, and that output changed when the other member was updated with its contributions. It also happens when deploy replaces a member delete-first, and deletes a member that this deploy created because it blocks the delete. Deploy fails with `ResourceCycleError` in both cases, and the error says which. In the second case, the next deploy creates the deleted member.

### Replacing a member of a cycle

A member with a `physicalName` param is replaced create-first, as any resource of its class. No member is deleted while the cycle settles. The members that refer to it are updated with the output of the replacement later in the same pass, or in the next pass, and the sweep deletes the replaced member at the end of the deploy. Its contributions that refer to its own outputs take the outputs of the replaced resource, and the next pass updates it with its own. The provider does not have to force a delete, and the replace can't fail with `ResourceCycleError` because it deletes a member that this deploy created.

The rest of this section applies to a member that is replaced delete-first. Deploy replaces it as it replaces any resource: it deletes the dependents that block the delete, deletes the member, and creates it again. The other members still refer to the member when it is deleted. A provider may refuse to delete a resource that another resource refers to. Cloudflare, for example, does not delete a Worker that another Worker binds, unless the delete is forced. So the provider must delete the member while a dependent in the deployment refers to it. See [Deletes of a resource that others refer to](#deletes-of-a-resource-that-others-refer-to).

The members that refer to the replaced member are updated with the output of the new resource when deploy reaches them: later in the same pass, or in the next pass. Until then, their references point at a resource that no longer exists. The replaced member is unavailable from its delete until its cycle settles.

A replaced member is created without some of its contributions in two cases, and the next pass updates it with them:

- It refers to itself through its contributions. They hold the output of the resource that was deleted.
- It refers through its contributions to a member that the replacement deleted as a dependent that blocks the delete. That member exists again only when deploy reaches it.

The same holds for a member that deploy replaces after it took the resource over in the same deploy; see [Taking a resource over](#taking-a-resource-over). That replace does not add a pass.

The removal of each dependent's record has the state write key `state:delete:<dependent id>:replace:<replaced id>`.

A member that depends on the replaced member is updated only when its params change. This holds when it takes an output that the replacement changes, such as the name. Deploy does not update a member whose params stay the same, so a provider whose references break for good when the target is deleted, even when a resource with the same name is created again, must make a replacement change an output that the dependents take. A Worker is replaced only when its name changes, and the Workers that bind it take its name.

Plan plans each member that comes before a replaced member a second time, after the replaced member, so that its node shows the update with the unknown output of the replacement, not a **noop** against the output of the old resource.

### Destroying a cycle

Destroy deletes the members of a cycle in the reverse of their order in deploy. A placeholder comes first in deploy, so it is deleted last, and it still refers to the members that are deleted before it. As in a replace, the provider must delete a resource that a dependent in the deployment refers to. Destroy does not read the current code for this, so a change to the code since the last deploy does not stop it.

The orphan sweep deletes orphans that form a cycle in storage order, and relies on the provider in the same way. This covers the ordinary case of removing two Workers that bind each other from code.

### Deletes of a resource that others refer to

A type that sets `deleteTakesDependents` gets a fourth argument in `delete`: `{ dependents }`, the resources whose state records depend on the deleted resource, each with its `id`, `type` and the `params` in its record. Deploy lists state just before the delete, in the step `dependents` of the delete's scope, so the list leaves out the dependents that it has already deleted. A dry run does not list state.

Deploy updates or deletes every dependent in the same run:

- In a replace, each dependent is a resource in code that deploy updates when it reaches it, or an orphan that the sweep deletes. The list also holds the retired instances of other records that depend on the resource, each with the ID of its record and its own params. The sweep deletes them.
- In the delete of a retired instance, the dependents in code are left out, as deploy has updated them to use the replacement. The list holds the retired instances of other records that depend on the resource, each with the ID of its record and its own params. The sweep deletes them first, so the list is empty unless they depend on each other, as the retired members of a cycle do.
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
- held as an output ref in its config or contributions, except a [state ref](../reference/resource.md#state-refs) and a ref to the resource's own `physicalName` param
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

**State refs.** Plan resolves each [state ref](../reference/resource.md#state-refs) from the outputs in state, as deploy does at its start, so the value is never unknown. A target with no record gives `undefined`.

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

The sweep deletes orphans in reverse order of these edges, as deploy and destroy do for resources in the graph. It deletes the [retired instances](#create-first-replacement) in the same order, with the orphans. A delete-first replacement deletes the dependents that block its delete in the same order; see [Dependents of a replaced resource](#dependents-of-a-replaced-resource). An edge to a resource that is not an orphan is ignored, including an edge to a resource that is no longer in state. A record written before edges were recorded has no `dependsOn`, and keeps its storage order among the orphans it has no edges to. The next deploy that reaches the resource writes its edges.

Orphans that form a cycle cannot be ordered. They, and the orphans that depend on them, are deleted first, in storage order. A provider that refuses to delete a resource that another orphan refers to fails the deploy, unless its type forces the delete; see [Deletes of a resource that others refer to](#deletes-of-a-resource-that-others-refer-to). An orphan in this group with no registered class does not keep the orphans it depends on in the group, as the sweep can delete them before it reaches the orphan.

The sweep looks up an orphan's class by its type in the caller's `registry`, merged with the classes of the resources in the graph. Each state record stores the provider of its resource in `provider`, a package name or a package subpath, which the resource class declares with `resource({ type, provider })`. `deployApp` and `destroyApp` in `@notation/core` collect the providers that state names, in a `notation:providers` step, and pass the resource classes that each provider exports. Only the records whose type has no class in the graph count, as the graph's classes cover the others. Each provider is resolved with `createRequire` from the project root, and then imported. A provider package is not always a direct dependency of the project, and pnpm does not link a transitive package into the project's `node_modules`. So a package that the root can't resolve is resolved from the real directory of each package in the project's dependency tree, breadth first, starting from the nearest `package.json` at or above the root, as Node resolves it when that package imports it. The walk stops at the first directory that resolves the package. If the tree holds two versions of a package, the first one found is loaded. A package is skipped, and a `reconciler.provider.load-failed` warning names it with the cause, when it can't be resolved, resolves to a builtin module such as `fs`, throws on import, or exports no resource classes that declare it as their provider. The loader takes the resource classes among the module's exports and among the values of each exported object, so a namespace export such as `lambda` is read. It reads `default` in the same way, because `import()` puts a CommonJS module's exports there. Other exports are ignored. A class whose `provider` is another package is ignored too, so each type is loaded only from the provider that its state record names. A provider name may contain only letters, digits, `_`, `.`, `~` and `-`, with an optional leading `@` and `/` between segments, and no segment may start with a dot. A record whose provider is not such a name, such as a relative path, an absolute path or a Windows drive path, is skipped in the same way. A record with no `provider` was written by an earlier version, and plan, deploy and destroy fail on it at the start. Deploy and destroy emit the warning in a step under `notation:providers:<package>`, so a resumed execution does not emit it again. The sweep's `reconciler.orphan-deletion.skipped` warning still names each record that is left in place. Core does not list the provider packages, so a provider from outside this repository works the same way. `planApp` loads the same packages without a step, so plan finds the same blocking dependents as deploy. Without these classes, a record whose type no longer appears in the graph could not be deleted. The packages are read before the deployment hold. So when an execution waits on another's hold, it does not have the packages of the records that the other execution writes, and its sweep skips those records as orphans until the next deploy.

When an orphan's type has no registered class, the sweep keeps the orphan and every orphan it depends on, directly or through another orphan. In destroy, it also keeps every resource in the desired set that the orphan depends on, directly or through another kept resource, and destroy does not delete those resources. The `reconciler.orphan-deletion.skipped` warning names the kept resources in `keptDependencies`. Each orphan with no registered class emits its own warning, including an orphan that another skipped orphan already keeps.

Dry-run deploy performs decisions and emits lifecycle events without provider mutations or state mutations. When drift detection is enabled, it can still call provider read operations to decide whether a nominal noop has drifted.

## Destroy flow

`destroy` is a first-class durable operation. It takes the same deployment hold as deploy, and deletes every registered record in state, each after the records that depend on it. It conditionally removes each resource store only after the provider delete succeeds or reports that the resource is already absent.

Destroy deletes a record's [retired instances](#create-first-replacement) just before the record. A record's edges are its edges in code, the edges in its state record, and the edges of its retired instances. So a dependent that a stopped deploy did not reach, and that still uses a retired instance, is deleted before that instance. A record whose edge in state still points at a resource is deleted before that resource, also when its code no longer depends on it.

Destroy runs these steps:

1. Destroy lists state, under the step key `notation:orphans:list`. It keeps each record whose type has no class, and the records that it depends on, as described above.
2. Destroy takes a base order: the orphans in the order of deploy's sweep, then the resources in code in the reverse of their order in deploy.
3. For each record in the base order, destroy first deletes each record that has an edge to it and is not yet deleted, in the same way. Then it deletes the record. An edge between two members of a cycle is skipped, so a cycle is deleted as described in [Destroying a cycle](#destroying-a-cycle). When edges form a loop across deploy units, the record that comes first in the base order is deleted last.

An orphan is deleted under the step keys `notation:orphans:<id>`, and a resource in code under `notation:destroy:<id>`.

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

Lifecycle events cover create, read, update, and delete with `start`, `success`, `error`, `skip`, or `dry-run` status. The delete of a dependent that blocks the delete of a replaced resource has `reason: "dependency-replaced"`, and names the replaced resource in `replacedDependency`. The delete of a retired instance has `reason: "retired"`, and the resource ID of its record. The decision event of a replace has `replaceOrder`, `create-first` or `delete-first`.
