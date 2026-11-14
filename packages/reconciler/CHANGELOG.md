# @notation/reconciler

## 0.20.0

### Minor Changes

- a9e3fe4: Secrets take their values from sources, part 2 of RFC 0017. Notation writes a secret's value to its store, and never records the value.

  - `secret({ id, source, key })` from `@notation/cloudflare/secrets-store` takes its value from a source. `@notation/std/sources` exports `env`, which reads `process.env`, and `dotenv(path)`, which reads a `.env` file relative to the project root. `source` and `key` are given together. Each secret with a source has a `SourceValue` resource, `value:<id>`, which records the secret's id, the source's name, the key and a version. `env` and `dotenv` have no versions, so their secrets are written on every deploy. A source's `version` may return `undefined` for one key, which is then written on every deploy too. Plan and deploy fail when the source doesn't have the key.
  - A secret without a source takes its value from a hidden prompt, when deploy creates it. With no terminal, or with `--json`, deploy fails with the command that sets the secret. `notation watch` asks at each deploy that needs the value. Plan never asks, and notes that deploy will. A secret without a source that already exists is recorded without asking.
  - `notation secret set <id>` writes a secret's value, read from a hidden prompt or from stdin. `notation secret delete <id>` deletes a secret, and needs `--yes` without a terminal. Both refuse an API token's secret.
  - `SecretsStoreSecret` now requires `ValueFrom`, and its create and update write the value.
  - `Redacted` from `@notation/core` holds a secret value. Turning it into a string or JSON throws, and `console.log` prints `Redacted(<hidden>)`. A source implements the `Source` interface from `@notation/std/sources`, and a resource reads a value with `getValue(id)`.
  - The reconciler removes every secret value that the process read from the errors of operations before it records them, and the CLI removes them from the error that it prints when a command fails.

### Patch Changes

- aa8eea2: A resource that is constructed while infra is evaluated is now part of the deployment when no group adds it, such as a top-level `new workers.WorkerScript(...)`. Before, deploy dropped it with no error, and plan showed nothing to create. The resource has `group: null`. When a group adds it later, `add()` sets its group. Adding a resource to two groups, or to one group twice, throws. Before, adding a resource to two groups threw only while a graph was being collected. The error now names the resource's type, its ID and the group it is in. A resource constructed while no graph is being collected joins no graph, as before.

  When a deployed resource moves into a group, out of one, or to another group, deploy now writes the new group to its record without calling `update`. Before, the record kept the old group until the resource next changed.

  Rolling back to an older CLI after a deploy with this version deletes resources. An older CLI does not collect a resource that no group adds. Its next deploy treats the resource as an orphan, because the resource has a record but is not in the graph, and deletes it.

- Updated dependencies [aa8eea2]
- Updated dependencies [a9e3fe4]
  - @notation/resource@0.20.0
  - @notation/utils@0.20.0
  - @notation/state@0.20.0

## 0.19.0

### Minor Changes

- 3628aa5: Deploy now creates the replacement of a resource with a generated name before it deletes the resource (RFC 0019). The AWS Lambda function, IAM role, SQS queue, EventBridge rule and bus, API Gateway API and the Cloudflare Worker have generated names.

  - A replace creates first when the resource's class has a `physicalName` param. Deploy writes the `creating` record of the replacement and adds the old resource to the record's list of retired instances in the same write. It then creates the replacement, and updates or replaces each dependent with the outputs of the replacement when it reaches it. At the end of the deploy, it deletes each retired instance.
  - Every other replace still deletes first. This includes a Lambda permission and an event source mapping, whose key comes from config or from their parents.
  - A dependent that blocks the delete of a resource that is replaced create-first is no longer deleted first. `blocksDeleteOf` is now used only by a replace that deletes first. For example, when a bus is replaced, each rule on it is replaced create-first too, and the old rules are deleted before the old bus.
  - When the create of the replacement fails, deploy writes back the record of the old resource, and nothing is deleted. When the create has an unknown outcome, the old resource stays retired, and the next deploy resolves the create.
  - A deploy that stops after the create leaves the old resource retired. The next deploy deletes it at its end, after it has updated the dependents that the stopped deploy did not reach.
  - The sweep at the end of a deploy deletes the orphans and the retired instances together, in reverse order of their edges. A record's retired instances are deleted just before the record. A dependent that is no longer in code is deleted before the retired instance that it uses.
  - When the provider refuses to delete a retired instance, the deploy fails and names the resources in code that depend on the resource. The instance stays retired, and the next deploy tries to delete it again. Destroy fails in the same way.
  - `notation destroy` deletes each record after the records that depend on it, by the edges in code, the edges in state, and the edges of the retired instances. It deletes a record's retired instances just before the record. So a dependent that a stopped deploy did not reach is deleted before the retired instance that it uses.
  - A delete-first replace, and the delete of a dependent that blocks it, delete the record's retired instances when deploy reaches the record. `notation plan` shows them just before the replace. A record whose retired instance depends on a resource that is replaced delete-first counts as a dependent that blocks the delete, when its type lists the resource's type in `blocksDeleteOf`.
  - `@notation/state`: a state record gains an optional `retired` list. Each entry holds the old resource's `config`, `params`, `output` and `dependsOn`, and `retiredAt`. Every write to the record keeps the list, and a record that lists retired instances is not removed.
  - An older version of the CLI does not keep the retired list. When it runs against state that this version wrote, a write that it makes to the record, such as a create or a delete-first replace, drops the list. The old resource then stays in the account with no record.
  - `notation plan` prints the order after each replace: `+/- replace ... (create, then delete)` for a create-first replace, and `-/+ replace ... (delete, then create)` for a delete-first one. It prints each retired instance that waits in state as `- delete-retired`, in the order of the sweep, with the time when it was retired, and counts it among the deletes in the summary.
  - `@notation/dashboard`: the resource list marks a resource that has retired instances, and the resource view lists them with the time when each was retired.
  - `notation plan --json` adds `replaceOrder` (`"create-first"` or `"delete-first"`) to each `replace` and `drift-replace` node. A retired instance that deploy deletes is planned as a node with the decision `delete-retired`, the ID of its resource, `retiredIndex`, its position in the resource's list of retired instances, its own params and edges, and `retiredAt`. So the plan can hold several nodes with the same `id`. The `id` and `retiredIndex` together name a retired instance. The deploy decision event carries `replaceOrder` too, and the delete of a retired instance has the reason `retired`.
  - `@notation/resource`: `ResourceDeletion.dependents` lists the retired instances of other resources that depend on the deleted resource. For the delete of a retired instance, it leaves out the dependents in code.
  - Two instances of a resource exist for part of a deploy, so a replace can fail on an account quota that it passed before. A queue that is replaced still loses its messages, at the end of the deploy instead of at the start.

- 19036ae: Deploy needs one new IAM permission, `logs:DescribeLogGroups`, for the log group's read. An authorizer is now looked up with `GetAuthorizers`, which needs `apigateway:GET` on the API's authorizers. A deploy that changes a log group's `kmsKeyId` or `tags` also needs `logs:AssociateKmsKey` or `logs:DisassociateKmsKey`, and `logs:ListTagsForResource`, `logs:TagResource` and `logs:UntagResource`.

  A deploy now takes over a resource that already exists, instead of failing. This recovers a resource that an earlier deploy created but did not record.

  - When a resource's `create` reports that the resource already exists, deploy takes the resource over, for every resource class. It reads the resource, records it with the params that the read returned, and then updates, replaces or keeps it. Every AWS name that Notation makes starts with `<app>--<stage>--`, so a resource with the same key belongs to the same deployment. Deploy does not check who made the resource. Deploy output prints `Took over <id>: it already existed, so deploy read it and now compares it with config` for each takeover.
  - `@notation/resource` adds `ResourceAlreadyExistsError`. A `create` handler throws it when the provider refuses the create because the resource already exists. A provider package should start each resource's name with the app and the stage, with `physicalName` on the name's schema item or with `scopedPhysicalName`, because deploy takes over any resource with the same key.
  - Deploy writes a state record with `lastOperation: "creating"` before it calls a resource's `create`, and replaces it when the create is done. Plan and deploy decide **create** for a resource with a `creating` record, and its dependents plan against unknown outputs. `notation plan` prints `recovers a create that an earlier deploy did not finish` under such a create.
  - `find` now takes only `params`, and `create` no longer receives a token. `find` returns the key of the one resource that a create with those params makes, throws `ResourceNotFoundError` when there is none, and must fail when several match. Deploy calls `find` before every `create` of a class that has `find`, and takes over what it finds. A resource whose key the provider assigns, such as an API Gateway API, is then not made a second time.
  - When the lookup of a create with an unknown outcome finds the resource, deploy takes it over too, and puts what is missing, such as a log group's retention, in the same deploy.
  - After a takeover, deploy updates each param that the resource's `read` does not return, because it cannot tell whether the param matches config. A param whose difference would replace the resource is assumed to match.
  - The create of a replacement does not take over a resource that has the key of the resource it replaces. A replacement with a generated name has a new name, so this applies to a resource whose key stays the same, such as a Cloudflare Worker. This holds when `find` returns the resource before the create, when the provider reports that the resource exists, and when the lookup of a create with an unknown outcome finds it. Deploy fails, and writes the record of the replaced resource back, so the next deploy replaces it again. The rule does not cover a dependent that the replace deleted because it blocks the delete, which deploy creates again later in the same deploy.
  - Deploy fails the create instead of taking a resource over when the provider assigns the resource's key and its class has no `find`, when `find` finds no resource or several, or when the class has no `read`.
  - When create fails and its outcome is not classified as unknown, deploy writes back the record that it started from, or removes the `creating` record when it started from none. This includes a create that the provider refused because the resource exists, when deploy cannot take the resource over. The create of a replacement then writes back the record of the replaced resource.
  - The orphan sweep and destroy delete the resource of a `creating` record by the key that `find` returns or that the record holds. When `find` finds no resource, or no key is known, they remove only the record, and emit a `skip` event with the reason `not-created` or `key-unknown`.
  - When the `creating` record names another key than config, the resource that the unfinished create may have made under the old key is left in the provider. A class with a key that the provider assigns and no `find`, such as API Gateway's `LambdaIntegration`, is created a second time when a create stops before deploy records it.
  - `awsCreate` in `@notation/aws/resources` takes an `alreadyExists` option. API Gateway's `RouteAuth` and `LambdaIntegration` now wrap their `create` in `awsCreate`, so a `CreateAuthorizer` or `CreateIntegration` call that times out or gets a server error has an unknown outcome, and the `creating` record stays. `LambdaIamRole`, `LambdaFunction`, `LambdaPermission`, `LambdaLogGroup`, `LambdaEventSourceMapping`, `eventBridge.EventBus`, `eventBridge.Rule`, `sqs.Queue`, and API Gateway's `Stage` and `Route` report an existing resource as `ResourceAlreadyExistsError`, as does Cloudflare's `WorkerScript`. A Worker with the same name that already exists in the account is now taken over.
  - API Gateway's `Api` and `RouteAuth` are found by name, `Route` by its route key, `sqs.Queue` by its name, and `LambdaEventSourceMapping` by its function and event source. `LambdaEventSourceMapping`'s `find` leaves out a mapping that is being deleted. `Api`, `LambdaFunction`, `LambdaEventSourceMapping` and `sqs.Queue` are no longer tagged with `notation:create-token` when they are created. A resource that an earlier version created keeps the tag, and deploy does not remove it. The read of an `Api` leaves the tag out of `Tags`, so the tag does not replace the API. `LambdaEventSourceMapping` supports one mapping per function and event source.
  - `LambdaLogGroup` gains a `read`, so deploy takes over a log group with the function's log group name. This covers the log group that Lambda makes when a function first logs, and one that a deleted function left. Its update now sets each changed param with its own API call. Before, a change to `kmsKeyId` or `tags` was sent to `PutRetentionPolicy`.
  - `LambdaLogGroup` reports a failure to set its retention policy, after the log group was made, as `ResourceCreationUnknownError`. The EventBridge rule and `sqs.Queue` check that no resource with the name exists before they create it. When the rule's targets can't be put during create, it deletes the rule, and reports a failed delete as `ResourceCreationUnknownError`. `LambdaRolePolicyAttachment` treats a detached policy as deleted.

  Deploy now generates the AWS names of functions, roles, queues, rules, schedules, event buses and APIs, and config cannot set them.

  - **Breaking:** `lambda()`, `$lambda`, `queue()`, `api()`, `eventBus()`, `rule()`, `schedule()` and `eventBridge.bind(bus).defineRule()` no longer take a `name` option. A resource class carries all of the provider's fields, including the name field, but the reconciler generates the name from the resource ID. There is no override for now. If an exact name is needed later, an override will be added then. `jwtAuthorizer()` keeps its `name`, which is unique only within its API, and a Cloudflare Worker keeps its name.
  - A declaration gets a generated name: `<app>--<stage>--<base>-<instance>`. The base is the resource's state key without its type prefix, in lower case, with each run of characters other than `a-z` and `0-9` turned into one `-`. The instance is 8 random hex characters. For example, `$lambda({ id: "todos" })` is named `my-app--prod--todos-1a2b3c4d`, and its role `my-app--prod--todos-role-5e6f7a8b`. Before, they were named `my-app--prod--todos` and `my-app--prod--todos-role`.
  - Deploy generates Lambda's `FunctionName`, the Lambda role's `RoleName`, SQS's `QueueName`, the `Name` of an EventBridge rule, schedule and event bus, and the `Name` of an API Gateway API. A FIFO queue's generated name ends in `.fifo`. A Cloudflare Worker's name does not change.
  - Deploy generates the name when it first creates the resource, and keeps it in state. Later deploys read the name from state. Deploy writes the name in the `creating` record before it calls the provider, so a deploy that stops during the create finds the resource again under the same name.
  - **A resource that is already in state keeps its name.** An upgrade renames nothing. A resource gets a generated name when deploy next replaces it.
  - A replace still deletes the resource first. The replacement of a resource with a generated name gets a new name. So the replacement of such a queue does not wait for SQS to release the old name.
  - A resource that an earlier version named from its `name` keeps that name when you remove `name`, until deploy next replaces it.
  - `notation plan --json` shows a generated name as `{ "$unknown": "after-apply" }` until the resource exists, and for a resource that deploy replaces. A param that takes the name, such as a role policy's `RoleName` or a rule's `EventBusName`, is unknown until then too. The plan of a replace does not list the name among the changed fields.
  - The infra code can't read a generated name. Read it through an output ref, such as `ordersBus.name`.
  - The constructs no longer check that no two declarations get the same AWS name, because a generated name has its own instance. Two Lambda functions whose ids differ only in case, such as `myFn` and `myfn`, are allowed.
  - A generated name that is too long is cut before the instance. With a long app name and a long stage name, the cut removes the whole id, and such names differ only in the instance.
  - `@notation/resource`: a param's schema item takes `physicalName: PhysicalNameRule`, which has `maxLength` and two new fields. `ending` is a function that takes the resource's params and returns the ending of a generated name, such as `.fifo`. `ending` replaces `requiredEnding`, which is removed, and `physicalName` and `scopedPhysicalName` no longer keep an ending when they shorten a name. `base` is a function that maps the resource ID to the base of a generated name, and without it the base is the whole resource ID. The config type leaves out a param with `physicalName`, and plan and deploy throw when `deriveParams` or untyped config supplies it. Deploy always generates it. `generatedPhysicalName` makes the name. A dependent reads the name through an output ref, because config does not hold it. `scopedPhysicalName` stays the tool for a fixed name on a class without `physicalName`, such as a Cloudflare Worker's.
  - **Breaking:** `deploy` in `@notation/reconciler/durable` takes a required `nameScope: { app, stage }`. `deployApp` in `@notation/core` passes the deployment's app and stage.

  Generated names have these limits:

  - A generated name is only in state. If the state record of a resource with a generated name is lost, other than by a deploy that stopped during the create, the next deploy creates a second resource with a new name, and the first stays in AWS.
  - If the create of a queue ends with an unknown outcome and you then turn `fifo` on, state keeps a name without `.fifo`, and deploy fails until you turn `fifo` off again.

- e41a52e: Add two kinds of ref that add no dependency, for resource packages.

  - `resource["~state"].outputRef(key)` reads an output from the target's state record at the start of the deploy, and at plan. It resolves to `undefined` when the target has no record. It reads only a param that is `immutable`, `primaryKey` or `secondaryKey`, or that has `physicalName`, and that is not `hidden`. It throws for any other output. It can only be placed in a contribution: `getDependencies()` throws when config holds one.
  - **Breaking (types):** `BaseResource` gains the members `"~state"` and `isStateRefTarget()`. Code that implements the `BaseResource` interface without extending `Resource`, such as a test double, must add them.
  - A ref from a resource to its own `physicalName` param is filled in with the name before `create`, so the resource is created once and is not a cycle of one.

### Patch Changes

- Updated dependencies [3628aa5]
- Updated dependencies [19036ae]
- Updated dependencies [e41a52e]
  - @notation/state@0.19.0
  - @notation/resource@0.19.0

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
