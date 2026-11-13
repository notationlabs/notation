# @notation/reconciler

## 0.18.0

### Minor Changes

- 968e03d: A Durable Object namespace is deleted only when it is unprotected in state. Plan and deploy fail, before deploy changes anything, for a change that would delete a protected namespace.

  - `$durableObject({ id, class, protect })` takes `protect`, which defaults to `true`. Plan reads it from the state of the hosting Worker. To delete a namespace, deploy `protect: false` first, which updates the Worker. A later deploy can remove the declaration, remove the Worker, or change the Worker's `id` or `name`.
  - Plan fails when a Worker no longer hosts a protected namespace that it hosted. This covers a removed declaration, and a changed `id`, with or without a changed `class`. Before, deploy deleted the namespace.
  - Deploy moves a namespace, with its objects, when its class export moves to another Worker and the old host still binds the namespace. The new host's upload moves it, using Cloudflare's `expecting-transfer` and `transferred` exports entries. Plan fails when the old host no longer binds a protected namespace whose class moved, when the move also changes the class, and when the new host gets a namespace that another Worker binds in the deploy that renames or deletes another of its namespaces. Deploy fails before any upload when the new host is created in the same deploy, which plan doesn't catch, and when the old host hosts a namespace that Cloudflare doesn't list as SQLite. Before, deploy deleted the namespace on the old host, and the new host got a new, empty namespace.
  - Plan fails when a Worker that hosts protected namespaces is removed or replaced, as when its `id` or `name` changes. Before, deploy deleted the Worker with its namespaces.
  - The check that a namespace doesn't take another namespace's class runs at plan, not during the Worker's upload.
  - `defineOperations` takes `rejectChange(previous, desired, { replace })`. It returns a message to fail plan and deploy with. The resource class and its instances expose it. Plan and deploy call it for each resource that has a state record, and for each orphan that the orphan sweep deletes, with `desired` undefined. `replace` is true when deploy deletes the resource and creates it again, also when a replaced dependency's delete needs it deleted first. `notation destroy` doesn't call it.
  - Deploy now fails with a param's `rejectReplace` message before it changes any resource, when the param's value is known before deploy. Before, deploy failed just before the resource's operation.

### Patch Changes

- Updated dependencies [968e03d]
  - @notation/resource@0.18.0
  - @notation/state@0.18.0

## 0.17.0

### Minor Changes

- 614ce3f: Deploy resources that depend on each other through contributions, as RFC 0011 describes. Before, plan and deploy failed on any dependency cycle.

  - In each loop, deploy picks a placeholder: a member that depends on the others only through its contributions, whose params that those contributions set are optional and don't force a replacement, and whose type has `update`. Deploy creates it without the contributions that refer to the other members, creates the other members, and then updates it with its full params. With drift detection, a placeholder that no longer exists is created again in the first pass. A dry run stops after the first pass, and then reports the decision for each placeholder that has a record.
  - Deploy then applies every member again until no output changes, for at most one pass per member, and at least two. If an output still changes, deploy fails with `ResourceCycleError`, naming the outputs that changed. When no member of a loop can be the placeholder, plan and deploy fail with `ResourceCycleError`, which says why for each member.
  - Deploy replaces a member of a cycle as it replaces any resource, and destroy deletes the members of a cycle in the reverse of their order in deploy. In both, a member is deleted while another member still refers to it, and the orphan sweep does the same for orphans that refer to each other. Each replace of a member adds a pass. A replaced member is created without its contributions that refer to itself, or to a member that the replacement deleted because it blocks the delete, and a later pass updates it. A placeholder's record leaves out the edges to the members it was created without.
  - A type can set `deleteTakesDependents`. Its `delete` then gets a fourth argument, `{ dependents }`: the resources whose state records depend on the deleted resource, which deploy updates or deletes in the same run. A provider that refuses to delete a resource that others refer to can force the delete when every reference comes from a dependent. Exports `ResourceDeletion` from `@notation/resource`.
  - The removal of the record of a dependent that blocks the delete of a replaced resource has the state write key `state:delete:<id>:replace:<replaced id>`, so that two replacements in one deploy can each delete the same dependent.
  - Plan nodes have `cycle` and `placeholder`. Plan plans a member that comes before a replaced member again, so that it shows the update that deploy makes, and `notation plan` prints a line for a placeholder. Plan nodes have `brokenDependents` for a replaced resource whose type sets `deleteTakesDependents`: the declared resources whose records depend on it and that deploy does not delete first. `notation plan` prints them, as their references to the resource are broken from the delete until deploy updates them.
  - Resources have `getFixedDependencies()` and `getContributedParams({ from })`, and `getParams({ excludeContributionsFrom })` returns the params without the contributions that depend on the given resources. Exports `changedKeys` and `forcesReplacement` from `@notation/resource`.
  - `@notation/cloudflare`: a Worker's service binding to another Worker is a contribution to its script's `Bindings`, which is now a collected param. Two Workers can bind each other as services. Cloudflare refuses to delete a Worker that another Worker binds as a service, or whose Durable Object namespace another Worker binds. `WorkerScript` now forces that delete when every Worker that refers to it is a dependent in the deployment, and fails with an error that names the other Workers when one is not. So a Worker that other Workers of the app bind can be renamed, and two Workers that bind each other can be destroyed or removed from code. Workers that each bind a namespace that the other hosts still fail plan. The service bindings now come after the bindings in config, so a Worker whose service bindings came before other bindings is updated once on the next deploy.

- 35206ce: The durable runtime package is now `@notation/durable` 0.9.0. It replaces `yieldstar`, `@yieldstar/core` and `@yieldstar/sqlite-runtime`. An application that composes `deploy` or `destroy` in its own workflow must import from `@notation/durable` instead:

  - `yieldstar` becomes `@notation/durable`.
  - `@yieldstar/core` becomes `@notation/durable/runtime`.
  - `@yieldstar/sqlite-runtime/node` becomes `@notation/durable/sqlite/node`.

- e4f4157: `resource()` now requires `provider`, the name of the package that exports the resource class. Each state record stores it, so that deploy and destroy can delete a record whose type is no longer in code.

  ```ts
  const queue = resource<QueueSchema>({
    type: "aws/sqs/Queue",
    provider: "@notation/aws/resources",
  });
  ```

  This breaks every resource class outside this repository: a class without `provider` fails type checking.

  - A provider is a package or a package subpath that exports resource classes, or namespaces of them. Its entry has a `default` condition in `exports`, so that it can be resolved with `require` conditions. `@notation/aws/resources` and `@notation/std/resources` do both.
  - `planApp`, `deployApp` and `destroyApp` in `@notation/core` load the provider packages of the state records whose type has no class in code. A package that can't be resolved or that throws on import is skipped with a `reconciler.provider.load-failed` warning, and its records stay in state.
  - Before, an orphan whose type was no longer in code was left in place. Deploy now deletes it through the class of its provider package. This removes the limit on renaming an EventBridge bus in the deploy that removes its last rule.
  - A resource whose ID is that of a state record of another type fails plan, deploy and destroy with `ResourceTypeChangedError`, before any change. A provider that changes a resource's type must give it a new ID.
  - State written by an earlier version is not supported, as its records have no `provider`. Destroy the stack with the earlier version before you upgrade.

- f490162: A param's schema item can set `rejectReplace: (previous, desired) => string`. When a change to the param would replace the resource, plan and deploy fail with the returned message, instead of replacing the resource.
- 7eb8766: A resource type can list the types it blocks the delete of, with `blocksDeleteOf` in `resource({ type, ... })`. For example, AWS does not delete an EventBridge bus that has rules, so an EventBridge rule type can list the event bus type:

  ```ts
  const eventBridgeRule = resource<EventBridgeRuleSchema>({
    type: "aws/eventBridge/rule",
    blocksDeleteOf: [EventBus.type],
  });
  ```

  When deploy replaces a resource, it first deletes each dependent whose type lists the resource's type, and each dependent that blocks the delete of one of those in turn. It deletes them in reverse dependency order. Then it deletes the resource and creates it again, and creates the deleted dependents again with the new resource's outputs. Every other dependent stays in place, and deploy updates it when its params change, as before.

  - `blocksDeleteOf` takes resource types. The resource class exposes the list as `blocksDeleteOf`.
  - The dependents are found by the edges in state. An orphan is checked with the registered class of the type in its record, and is deleted before the replaced resource too. An orphan whose type has no registered class is treated as not blocking the delete.
  - A dependent of several replaced resources is deleted and created once. If the deploy stops part way, the next deploy creates each dependent that has no record.
  - The plan shows each deleted dependent as `replace`, with `replacedDependency` set to the ID of the replaced resource. `notation plan` prints `deleted before <id> is replaced` under it.
  - `createPlan` and `planApp` take a `registry`, as deploy does.
  - The delete of a dependent emits lifecycle events with `reason: "dependency-replaced"` and `replacedDependency`.

- 6cec012: Every schema item has a required `value` validator (RFC 0006). It can be any Standard Schema, such as a valibot, Zod, ArkType or Effect schema. The engine calls only `~standard.validate`.

  ```ts
  MaxSessionDuration: {
    propertyType: "param",
    presence: "optional",
    value: v.number(),
  },
  ```

  The validator's output type is the field's type, and TypeScript checks it against the API schema's type for the field. `value` replaces `valueType`, and `typed` is removed.

  The engine validates config when a resource is declared, known params at plan, known params before deploy changes anything, each resource's full params just before its operation, and every `create` and `read` result. An invalid value raises `ValueValidationError`, which names the resource, the field and the call site that declared the resource. A malformed read fails the plan or deploy. A value that holds an unknown, such as a policy document with one output ARN, is validated with the unknown in place, and only the issues that the unknown could cause are dropped.

  The engine also raises `SchemaStructureError` when params hold a field that is not a param, when `create` returns a field that is not computed, when params leave out a required param, or when a required computed field is missing after create or update. A later deploy that finds the output missing from the record reads the resource again, and fails while the output is still missing.

  The resources in `@notation/aws/resources` now reject values that AWS would reject: a value not in the SDK's list for an enum field, an SQS queue attribute outside its range, a `TimeoutInMillis` that is not an integer, and a role policy document that does not follow the IAM policy grammar. `InvocationType` is removed from `LambdaApiPermission` and `LambdaEventBridgeRulePermission`, because `AddPermission` does not accept it and the SDK dropped it.

  Known limit: string-union fields are checked against the SDK's list of values. A value that AWS adds after the pinned SDK version, such as a new Lambda runtime, fails validation. A read that returns such a value fails the plan. It also fails every deploy of the stack, including a deploy with no changes, because drift detection reads each unchanged resource. This lasts until the SDK is bumped, or until RFC 0009 makes malformed reads recoverable. Destroy still works, because delete does not read.

### Patch Changes

- ae3d823: The packages are built with tsdown instead of tsup. The entry points and their types are at the same paths. Shared code sits in chunks with different names, and imports of Node built-ins keep their `node:` prefix. The `@notation/aws` entry points now share chunks instead of each bundling its own copy, so they share module state.
- d00b769: Plan treats a required output that is missing from a dependency's state record as unknown, as it does for a dependency that hasn't been created. A record written before an output was added to its resource type lacks the output. Before, plan read it as `undefined`, so a dependent's required param was missing, and plan and deploy failed before any change. Now the dependent's params that use the output are shown as unknown. Deploy reads the dependency again, fills in the output and then deploys the dependent.
- aa5b5d9: Plan and deploy replace a resource whose type has no `read` and whose state record lacks a required output. Before, plan and the deploy check failed with `SchemaStructureError`, though the replace deletes the resource and creates it again, and the create writes the output. This also applies to a resource that deploy deletes before it replaces a dependency. Plan and deploy still fail when the deploy would leave the resource unchanged or update it.

  When an immutable param of such a resource takes an output of a replaced dependency, plan can't know the output, so the replace is only possible. Plan passes in this case. Deploy replaces the resource if the output changes. If the output stays the same, deploy leaves the resource unchanged, and it fails when it reaches the resource.

  Deploy now checks such a resource when it reaches it, not in the check before any change. When the decision is update, deploy fails before it calls the resource's `update`.

- 4776f9f: `ResourceOperationPendingError` takes a `throttled` option. Set it to `true` when the provider refused the request because of a rate limit. A throttled `read` doesn't report that the resource exists: after a create with an unknown outcome, the reconciler looks the resource up again instead of recording the create as finished.
- Updated dependencies [ae3d823]
- Updated dependencies [614ce3f]
- Updated dependencies [ce76cd5]
- Updated dependencies [d00b769]
- Updated dependencies [8839f28]
- Updated dependencies [f490162]
- Updated dependencies [e9da750]
- Updated dependencies [e4f4157]
- Updated dependencies [f490162]
- Updated dependencies [7eb8766]
- Updated dependencies [1cce9df]
- Updated dependencies [3fefade]
- Updated dependencies [ce76cd5]
- Updated dependencies [121442b]
- Updated dependencies [4776f9f]
- Updated dependencies [6cec012]
- Updated dependencies [f490162]
  - @notation/resource@0.17.0
  - @notation/state@0.17.0

## 0.16.0

### Minor Changes

- 19a9d2e: Collected params: several pieces of code can add to one param.

  - A schema item with `collect` makes its param collected. `collect` combines the config value and every contribution, sorted by content.
  - `resource.contribute(values)` adds to a collected param while infra is evaluated. Contributions close when evaluation ends.
  - `resource.contribute(({ deps }) => values, { deps })` adds values computed from the real outputs of `deps` at deploy. The resource depends on `deps`.
  - `mergeContributions` merges maps key by key. Two contributions that set one key to different values throw `ContributionConflictError`, which names the `file:line` of both `contribute` calls.

  Output values: config can hold a resource's output before the resource exists.

  - `resource.outputValue(key)` returns a token. The holder depends on the resource, and deploy replaces the token with the real output.
  - Turning a token into a string throws `OutputValueStringError`. Compute with outputs in `deriveParams` or a function contribution.

  Plan:

  - A value that waits on an undeployed output shows as unknown at its own path.
  - `deriveParams` and function contributions receive views of their deps. Reading the output of an undeployed dep throws `PendingOutput`, and plan marks the affected params unknown.
  - Plan and deploy fail when a resource depends on a resource that is not part of the deployment. Before, the graph ignored the edge.

  Other:

  - `resource.dependOn(other)` adds a dependency after construction.
  - `onEvaluationEnd(callback)` runs a callback after evaluation, before contributions close.
  - `@notation/utils` adds `sortedJson`, JSON with sorted keys.

- 35196ff: Each state record stores the IDs of the resources it depends on in `dependsOn`. Deploy and destroy delete orphans in reverse order of these edges, so removing a construct such as a Lambda deletes its policy attachment before its role. A resource whose edges change but whose params do not has only `dependsOn` rewritten, with no provider call. Records written before this change have no edges until the next deploy writes them, and until then are deleted in storage order. Destroy deletes orphans before the resources in the desired set, so an orphan is deleted before a resource it depends on. When an orphan's type is not registered, the orphans it depends on are kept too, and in destroy so are the resources in the desired set that it depends on. `reconciler.orphan-deletion.skipped` names them in `keptDependencies`. A plan node lists `dependsOn` sorted and deduplicated. `CreateResourceParams` and `UpdateResourceParams` take a required `dependsOn`.
- 7d01d51: Migrate the durable runtime to yieldstar 0.8.2.

  - `--execution-id` now reports the recorded error for a `failed` execution instead of replaying it. Start a new deploy to recover.
  - When the workflow throws, the execution releases its deployment hold.
  - The reconciler keeps the properties of a `create` or `read` result that the schema declares. A `Date`, `Map`, `Set` or `bigint` is recorded as it is. A `Buffer` or other class instance fails the step with `WorkflowValueError` (`INVALID_STEP_VALUE`).
  - Databases, executions and tables from yieldstar 0.5 are not migrated.
  - Each create attempt runs as a yieldstar `step.effect`. When the outcome of an attempt is unknown, the reconciler looks the resource up before it calls `create` again. The outcome is unknown after the process stops between `create` and the recorded result, or when `create` throws `ResourceCreationUnknownError`. Create attempt step keys change from `*:create:remote:attempt:<n>` to `*:create:remote:effect:<n>`.

  `@notation/resource` and `@notation/state`:

  - `defineOperations` takes an optional `find(params, token)`. `create` throws the new `ResourceCreationUnknownError` when it cannot tell whether the provider made the resource. `create` receives the attempt's token as its third argument. `Resource.keyOf(output)` returns the key that `output` gives.
  - `DurableValue`, `DurableObject` and `Durable<T>` describe the values the reconciler records. `Resource.toResult` keeps the properties of a provider result that the schema declares.
  - A provider that returns a `Buffer` does not compile. `StateNode` holds durable values, and `ResourceOperationPendingError.callbackContext` is a `DurableObject`.

  `@notation/std.iac` and `@notation/aws.iac`:

  - The Zip and File outputs replace `file` with `fileSha256`.
  - The Lambda's `Code` param is replaced by `CodeFilePath`.
  - The Lambda's `CodeSha256` param holds a base64 SHA-256 of the uploaded bytes instead of a hex SHA-256 of the source. Drift detection no longer reports every Lambda. On the first deploy after the upgrade, each Lambda uploads its code once.
  - An API Gateway API is tagged `notation:create-token` with a hash of its create token, and its read leaves the tag out of `Tags`. A Lambda function gets the same tag. After a create with an unknown outcome, the API is found by the tag, a route by its route key, and a Lambda function by its name and the tag. A function with the same name and without the tag fails the create instead of being taken over. An API, route or Lambda create that times out, loses its connection or gets a server error is looked up instead of failing the deploy.
  - An API Gateway integration or authorizer cannot be looked up. After a create with an unknown outcome, the next deploy can create a second one that Notation does not record or delete. See the API Gateway docs.

### Patch Changes

- Updated dependencies [19a9d2e]
- Updated dependencies [35196ff]
- Updated dependencies [7d01d51]
  - @notation/resource@0.16.0
  - @notation/state@0.16.0

## 0.15.0

### Minor Changes

- 7a90e6b: Resource groups now have stable string IDs. Previously, a group's ID was its position in the graph, so adding a group shifted the IDs of every group declared after it, and groups built outside a graph all had the ID `-1`.

  - `ResourceGroup` requires an `id`, a string that must be unique among groups of the same type. Declaring two groups with the same type and ID in one graph throws.
  - `LambdaGroup` uses the lambda's `id`, `ApiGroup` the API's `name`, `RouteGroup` `<api id>-<method>-<path>` and `ScheduleGroup` the schedule's `name`.
  - `ResourceGroup`'s `type`, `id`, `config` and `resources` are read-only.
  - Resources record their group as `resource.group`, a `{ type, id }` pair, or `null` if they are in no group. This replaces `groupId` and `groupType`, in memory and in persisted state. `@notation/resource` and `@notation/core` export the pair's type as `ResourceGroupRef`.
  - The dashboard labels groups by type and ID, such as `Lambda get-todos`, instead of by position.

  State written by earlier versions still loads, deploys and destroys. Its records keep `groupId` and `groupType` until their resource is next created or updated, and the dashboard lists them as ungrouped until then.

### Patch Changes

- Updated dependencies [bddd9f8]
- Updated dependencies [18c2b4c]
- Updated dependencies [83f0de1]
- Updated dependencies [16a0209]
- Updated dependencies [b290eb1]
- Updated dependencies [7a90e6b]
- Updated dependencies [6508511]
- Updated dependencies [6943418]
  - @notation/resource@0.15.0
  - @notation/state@0.15.0

## 0.14.0

### Minor Changes

- 9afdb3c: The reconciler now replaces a resource when a change cannot be applied as an update: a change to an `immutable`, `primaryKey` or `secondaryKey` param, or any change to a resource with no `update` operation. Plans gain `replace` and `drift-replace` decisions with the `replaceFields` that force them, and `notation plan` marks replacements with `-/+`. A replacement deletes the resource and then creates it again, and its dependents plan against unknown params. The comparison lives in `diffParams` in `@notation/resource`, so any engine planning a Notation resource reaches the same decision. Drift now compares only fields present both remotely and in the desired params, and an unset param is treated as absent rather than unknown. The update operation now fails for a resource with no `update`, where it used to skip the change silently.

### Patch Changes

- Updated dependencies [9afdb3c]
  - @notation/resource@0.14.0
  - @notation/state@0.14.0

## 0.13.0

### Minor Changes

- b7119a8: Add durable Yieldstar 0.5.0 deploy and destroy workflows, a resident Node SQLite runtime for CLI execution, versioned event streams, backend-neutral dashboard state, and compiled infrastructure graphs.
- f7e9186: A resource `read` now returns the remote object or throws the tagged `ResourceNotFoundError`. Operations that have started but not settled throw `ResourceOperationPendingError` with their retry delay and optional callback context. The reconciler follows those explicit instructions instead of guessing retry behaviour from provider errors or call-site context.

### Patch Changes

- Updated dependencies [b7119a8]
- Updated dependencies [f7e9186]
  - @notation/resource@0.13.0
  - @notation/state@0.13.0

## 0.12.0

### Minor Changes

- Add `notation plan` command backed by a serializable `Plan` and
  `Reconciler.plan()`, surfacing the deploy/destroy operations a run would
  perform before executing them.

  Also bumps dependencies to clear all outstanding security advisories and
  upgrades the core toolchain: TypeScript 6, Vite 8, Vitest 4, and glob 13.

### Patch Changes

- @notation/resource@0.12.0
- @notation/state@0.12.0
