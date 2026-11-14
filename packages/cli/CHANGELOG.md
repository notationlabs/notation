# @notation/cli

## 0.21.0

### Patch Changes

- @notation/build@0.21.0
- @notation/core@0.21.0
- @notation/dashboard@0.21.0

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

- Updated dependencies [a9e3fe4]
  - @notation/core@0.20.0
  - @notation/build@0.20.0
  - @notation/dashboard@0.20.0

## 0.19.0

### Patch Changes

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

- Updated dependencies [3628aa5]
- Updated dependencies [19036ae]
  - @notation/dashboard@0.19.0
  - @notation/core@0.19.0
  - @notation/build@0.19.0

## 0.18.0

### Patch Changes

- @notation/build@0.18.0
- @notation/core@0.18.0
- @notation/dashboard@0.18.0

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

- ce76cd5: The compiler is built on Rolldown, in place of esbuild (RFC 0015). `@notation/esbuild-plugins` is replaced by `@notation/build`.

  - The builds find declaration functions by JSDoc marks in the packages that export them. `@declaration` marks a function that declares a function resource, such as `$lambda`, with the options that each build keeps. `@resource` marks a resource function, such as `queue`. `@resource runtime: schema` lists the options of the resource that a function reads. `@resource runtime:` with no options means the resource becomes `{}` in the function. The builds follow imports, re-exports and `export *` to the module that has the mark.
  - A declaration is written `const name = $lambda({ ... })` at the top level of its module, with an object literal that has no spread or computed keys. Any other call fails the build with its location, and so does a module with more than one declaration. A function that the user marks `@declaration` can call a declaration function inside it.
  - The infra build runs a stripped copy of each declaration module that the infra entry reaches. The copy keeps the declaration and the top-level statements that it uses. The handler, SDK clients, top-level `await`, logging and side-effect imports are removed. The declaration is wrapped in `__notation_declaredIn(...)`, which records the module's path, relative to the project root, and the name of its binding. The build fails if the module doesn't export `handler`, or if another module imports a name that the copy doesn't keep.
  - The runtime build bundles each declaration module to `dist/<module path>/index.mjs`, from a generated entry that re-exports `handler`. The declaration keeps only the options that the function uses: `id`, `event`, and the names of `env` without their values. An import whose uses the strip removed is removed too, so the bundle doesn't load the module it imports from, with or without `verbatimModuleSyntax`. Infra modules are marked free of side effects, so the bundler drops them when another module imports them. The build fails if a kept option refers to an infra module, or if an infra module or an infra function from a package, such as `queue()`, is still in the bundle. The error names the import chain from the function's module, and each use.
  - A resource from an infra module that a kept option names, such as `ordersQueue` in `sqs.bind(ordersQueue)`, becomes an object of the resource's runtime options in the runtime build: `sqs.bind({ schema: Order })`. Each option is imported from where infra imports it, which must be a shared module, a package, or a file that no glob matches and that calls no resource function at its top level. Each option must be a name that infra imports by name or as a default import, and not a member such as `schemas.Order` or an expression such as `Order.extend({ ... })`. The build fails if the resource is not a call to a resource function with an object literal, if the literal has a spread in place of a runtime option, written as a top-level const or in an object literal. The build can't tell a resource that a helper makes from a plain value, such as a schema, so the error says to declare a resource with a call to its resource function, and to move a plain value to a shared module. A resource marked with a bare `@resource` is not replaced, and gets the error for an infra value.
  - The strip follows `export default queue({ ... })` to the resource, and stops at an `export *` that leads back to a module it has visited. A resource that a `let` holds fails the build with the error for an infra value. A const of the function's module that holds a resource, such as `const local = ordersQueue`, fails the build with an error that says to pass the resource directly. A name that a local binding shadows, such as `q` in `(q) => sqs.bind(q)`, is left as it is. Added imports go after a hashbang line.
  - Packages stay external in the infra bundle, as before. Imports through tsconfig `paths` are bundled.
  - `compileInfra()` returns the declaration modules, as `{ path, binding, entry }`.

- d93d65a: Deploy now includes runtime modules that infra doesn't import. The infra build reads each file that `files.runtime` in `notation.config.ts` matches. The infra bundle imports the entry first, and then each of these files that calls a declaration function, such as `$lambda`. A file without a declaration is not imported.

  - In watch mode, the base directory of each `files.runtime` glob is watched, or its nearest existing parent, so a new runtime file is deployed without a restart.
  - The scan and the infra watcher skip `dist/`, `node_modules/` and dot-directories at any depth.
  - A file in the globs that can't be parsed fails the build, and the error names the file.

- 9d669fc: Each module's kind comes from globs in `files` in `notation.config.ts`. The kinds are `infra`, `runtime` and `shared`. The defaults are `infra/**`, `runtime/**` and `shared/**`, and each key replaces only its own default. A `!` glob excludes files from a kind. A glob that ends in `/` matches the files in that folder. A glob with no `*`, `?`, `[` or `{`, such as `"infra"`, matches that path and the files under it.

  ```ts
  export default defineConfig({
    app: "todos",
    entry: "infra/index.ts",
    files: { runtime: ["runtime/**", "jobs/*.ts"], shared: ["lib/**"] },
  });
  ```

  - **An infra module never runs in a function.** The runtime build leaves out every file that `files.infra` matches, even one that calls no resource function. A function that uses any value from such a file fails the build, even a plain constant. The error says to move the value to a shared module. Code that the function needs belongs in a shared module, or in a file that no glob matches.
  - **A setup module under `infra/` doesn't run in the function.** For example, `infra/setup.ts` sets a global, and a runtime module imports it with `import "../infra/setup"`. The runtime build leaves `infra/setup.ts` out, even though it calls no resource function, and the build doesn't fail. Move code that the function needs to a shared module, or to a file that no glob matches.
  - **Projects with infra outside `infra/` need `files.infra`.** Only `files.infra` makes a project file infra. A file that it doesn't match keeps its top-level code in the function, so if the file calls a resource function at its top level, such as `export const dlq = queue(...)` in `src/queues.ts`, a function that imports it fails the build. The error names the file and says to add it to `files.infra`, or, if the file holds a declaration, to move the call to an infra module. A kept option of a declaration that refers to a value from such a file, such as `event: () => sqs.bind(dlq)`, fails the build at the option's line. That error says to move a plain value that the option uses to a shared module, or to a file that no glob matches.
  - **A package file is infra only if `files.infra` matches it.** Package files are files outside the root, which include workspace packages, and files in folders below the root with a named `package.json`. `files.infra` can match only files below the root, so a workspace package outside the root is never infra. If the function imports a package file that calls a resource function at its top level, the bundle keeps the file and the build fails, unless the nearest `package.json` sets `"sideEffects": false` and the function uses no value from the file. For a file outside `node_modules`, the error says to set `"sideEffects": false` if the function uses no value from the file. If it does, the error says to read infra values through the declaration's `env()`, and to move a plain value that the function needs to a file that doesn't call a resource function. A file in `node_modules` gets no advice. A kept option that refers to a value from such a file fails at the option's line.
  - A shared module that either build includes fails the build if it declares a function, imports a resource function, or imports an infra or runtime module, directly or through modules that aren't infra or runtime. An import counts if the module uses it as a value, including as a JSX tag such as `<Comp />`. The error names the chain of imports with the position of each import. Projects with a `shared/` folder are checked by default.
  - A file that two kinds match fails the build, even if nothing imports it. The error names the file and both globs, and says which glob is a default. For example, `files: { infra: ["**/*.ts"] }` conflicts with the default `files.runtime`.
  - A declaration, such as `$lambda`, in an infra or shared module fails the build. A declaration in a file that no glob matches still works when infra imports it.
  - Errors that name an infra module say why it is infra, such as `infra/orders.ts, an infra module (files.infra: "infra/**", the default)`. Errors quote a glob as the config writes it.
  - `@notation/core` adds `NotationConfig.files`, `Build.files`, `ModuleFiles`, `ModuleGlobs`, `ModuleKind`, `moduleKinds`, `defaultModuleGlobs` and `resolveModuleGlobs()`.

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

- 121442b: Notation identifies a deployment by its app and its stage (RFC 0005). You can deploy one codebase to several stages.

  A project needs a `notation.config.ts`:

  ```ts
  import { defineConfig } from "@notation/core/config";

  export default defineConfig({
    app: "my-app",
    entry: "infra/api.ts",
    defaultStage: "dev",
  });
  ```

  - The app and stage names have 1 to 32 characters from `a-z`, `0-9` and `-`. They can't start or end with `-`, or contain `--`.
  - CLI commands take no entry path: `notation deploy --stage prod`.
  - Without `--stage`, a command uses `defaultStage`. If neither is set, the command fails.
  - `--config <path>` chooses a config file. Use one config for each entry point.
  - `watch` exits when the config file changes.
  - `--execution-id` reads the stage from the execution, so `notation deploy --execution-id <id>` resumes a deploy to any stage. The command prints this resume command with the execution ID.
  - The state key is `<app>:<stage>`.
  - AWS names are `<app>--<stage>--<id>`, such as `my-app--prod--todos-getTodos`. If a name is longer than AWS allows, Notation cuts it and ends it with an 8-character hash. Notation does not change a name that you set directly on an `@notation/aws/resources` resource, such as `QueueName`.
  - Lambda IDs can have up to 64 characters, up from 59.

  API changes:

  - `deployApp`, `planApp` and `destroyApp` take `deployment: { app, stage, entryPoint }` in place of `entryPoint`.
  - `NodeDurableRuntime` takes `deployment: { app, stage }` in place of `deploymentId`.
  - `loadProject()` returns `{ config }`. `setConfigFile(path)` chooses the config file, `configPath()` returns it, and `projectRoot()` returns its directory.
  - `resolveDeployment`, `resolveDeploymentIdentity` and `resolveEntryPoint` resolve a deployment from a loaded project. `resolveDeploymentId` returns its state key.
  - `readExecutionDeployment(executionId)` returns the app and stage saved with an execution. `resolveDeployment(project, { execution })` takes the stage from it. `parseDeploymentId` reads a state key back into its app and stage.
  - `collectResourceGraph(evaluate, { scope })` and `getResourceGraph(entryPoint, scope?)` take the app and stage. `physicalName` and `scopedPhysicalName` in `@notation/resource` build the AWS names.

- f490162: The compiler can build Cloudflare Workers and Durable Object namespaces, for a provider package to declare with `$worker` and `$durableObject`.

  - A `@declaration` mark without `entry:` gets no runtime bundle. `compileInfra()` returns such a module with no `entry`. Before, the entry defaulted to `handler`, so a project's own wrapper marked `@declaration` without `entry:` now gets no bundle, and no error. Add `entry: handler` to the mark. An empty `entry:` clause fails the build.
  - The infra strip doesn't follow the names in `runtime:` options. A Durable Object class that `class: Counter` names, and its imports such as `cloudflare:workers`, are left out of the infra build.
  - A `runtime:` option whose value is a name that the module declares or imports, such as `class: Counter`, becomes a function with that name in the infra build, so the declaration can read `config.class.name`. The name is the local name at the call site. Any other value, including a class expression, a method and a global such as `undefined`, becomes a function whose name is `""`. A method option, such as `class() {}`, no longer gives invalid code.
  - The infra build strips each runtime module that has no declaration, as it strips declaration modules. The copy keeps the exports that code that runs at deploy uses, and the statements that they need, across modules. Its other top-level code, including side effects, doesn't run at deploy. Before, such a module ran whole at deploy.
  - A `cloudflare:` import, such as `cloudflare:workers`, that kept code doesn't use is removed. Code that runs at deploy and uses a name from a `cloudflare:` module fails the build, with the file, the name and the module that imports it, such as a declaration with `label: Counter.name`. Before, the build warned, and the infra bundle failed when deploy imported it. A static `cloudflare:` import that is still in the infra bundle, such as `export * from "cloudflare:workers"` in an infra module, fails the build and names the importing file. A dynamic `import()` of a `cloudflare:` module builds without a warning.
  - `infraPlugin()` takes `entryPoint`, the infra entry, which the strip of runtime modules starts from.
  - The mark clause `platform: workerd` builds the runtime bundle for workerd: Rolldown's `neutral` platform, wrangler's conditions and `NODE_ENV` defines, and `cloudflare:` and `node:` imports left external. A bare Node built-in, such as `events`, is imported as its `node:` module, even when an installed package, such as a polyfill, has the same name. A `require()` of a built-in, as in a CommonJS package, gets a module that imports the `node:` module, as wrangler does. The bundle re-exports the module's other value exports besides the entry, such as Durable Object classes, and not the declaration or types. `compileInfra()` returns the module with `platform`.
  - workerd doesn't start a Worker whose module exports a primitive, `null`, `undefined` or a module namespace object. The build fails, with the file and line, for an exported `const` with a primitive initialiser, and for `export * as ns from`, in a `platform: workerd` module.
  - For a `platform: workerd` declaration, the `declaredIn` record also holds `exports` and `starExports`, so the provider can check at plan time that the Worker exports each bound class under its name. `declaredIn()` takes them as a fourth argument, `moduleExports`.
  - The runtime build marks each declaration call `/*#__PURE__*/`, so the bundler drops a declaration that the bundle doesn't use. The runtime half of a declaration function must have no side effects.
  - In watch mode, a runtime bundle reads its module from disk when it builds, so a module that removes an export no longer logs a false build error before the infra rebuild restarts the runtime watcher. A module that loses its declaration, its entry or its entry export writes no bundle, and the last bundle stays.
  - `createRuntimeEntry` is no longer exported from `@notation/build`.
  - `@notation/build` exports `platformOf(name)`, which returns a platform's definition, the type `Platform` of that definition, and `PlatformName`, which is `"node" | "workerd"`. A definition holds a function that returns the runtime bundle's Rolldown options, whether the runtime entry re-exports the module's other exports, and the platform's check of export values. `ModuleAnalyses.fromDisk(file)` analyses a module from its current source on disk.
  - `DeclarationModule` is a union of its valid cases: no entry, an entry on Node, or an entry with `platform` and `exports`. The type of the `declaredIn` record, `DeclaredIn`, has both `exports` and `starExports` or neither. The record's runtime shape is the same.

### Patch Changes

- ae3d823: The packages are built with tsdown instead of tsup. The entry points and their types are at the same paths. Shared code sits in chunks with different names, and imports of Node built-ins keep their `node:` prefix. The `@notation/aws` entry points now share chunks instead of each bundling its own copy, so they share module state.
- 02c1fe4: The runtime build's bundle check now says that the function uses an infra module, or a resource function such as `queue()`, and names the file and line of each use. It used to say that the function's bundle includes it. The check reads the code before Rolldown's minify pass, so an unused call to an infra helper or to `queue()` fails the build even though the minify pass removes the call from the final bundle. The old wording was false in that case. The same builds pass and fail as before.

  The error for a resource function now lists only the uses of that function. It used to list the uses of every resource function in the bundle.

  For example:

  ```
  The function in runtime/orders.ts uses infra/orders.ts, an infra module (files.infra: "infra/**", the default): orderQueue at runtime/orders.ts:15:31. It imports infra/orders.ts through runtime/orders.ts → infra/orders.ts. The runtime build leaves infra out, so runtime code can't use it. Read infra values through the declaration's env(). Move a plain value that the function needs, such as a constant, to a shared module (files.shared).
  ```

- 2f5bd13: `notation watch` now deploys a change that was saved during a deploy that failed. Before, the change was dropped and was not deployed until the next save.
- Updated dependencies [ae3d823]
- Updated dependencies [02c1fe4]
- Updated dependencies [ce76cd5]
- Updated dependencies [46890c7]
- Updated dependencies [d93d65a]
- Updated dependencies [9d669fc]
- Updated dependencies [35206ce]
- Updated dependencies [e4f4157]
- Updated dependencies [7eb8766]
- Updated dependencies [1cce9df]
- Updated dependencies [ce76cd5]
- Updated dependencies [3fefade]
- Updated dependencies [121442b]
- Updated dependencies [6cec012]
- Updated dependencies [f490162]
  - @notation/core@0.17.0
  - @notation/dashboard@0.17.0
  - @notation/build@0.17.0

## 0.16.0

### Patch Changes

- Updated dependencies [19a9d2e]
- Updated dependencies [7d01d51]
  - @notation/core@0.16.0
  - @notation/dashboard@0.16.0
  - @notation/esbuild-plugins@0.16.0

## 0.15.0

### Minor Changes

- 4fe4451: Paths are now relative to the project root (the nearest directory with a package.json, starting from the working directory), not the working directory. This covers deployment IDs, Lambda IDs, build output, the state database and the files that file and zip resources read. You can run the CLI from any folder inside the project and get the same result.

  This is a breaking change. Deployment IDs used to be absolute paths, so Notation will not find the state of existing deployments. Destroy them before upgrading, or redeploy and delete the old resources by hand.

### Patch Changes

- 7735a67: `notation watch` runs each deploy in a fresh child process, so its memory no longer grows with every rebuild. `notation deploy` gains `--no-compile` and `--no-drift-detection`.
- Updated dependencies [16a0209]
- Updated dependencies [425f8ba]
- Updated dependencies [b290eb1]
- Updated dependencies [4fe4451]
- Updated dependencies [7a90e6b]
- Updated dependencies [6943418]
  - @notation/esbuild-plugins@0.15.0
  - @notation/core@0.15.0
  - @notation/dashboard@0.15.0

## 0.14.0

### Minor Changes

- 9afdb3c: The reconciler now replaces a resource when a change cannot be applied as an update: a change to an `immutable`, `primaryKey` or `secondaryKey` param, or any change to a resource with no `update` operation. Plans gain `replace` and `drift-replace` decisions with the `replaceFields` that force them, and `notation plan` marks replacements with `-/+`. A replacement deletes the resource and then creates it again, and its dependents plan against unknown params. The comparison lives in `diffParams` in `@notation/resource`, so any engine planning a Notation resource reaches the same decision. Drift now compares only fields present both remotely and in the desired params, and an unset param is treated as absent rather than unknown. The update operation now fails for a resource with no `update`, where it used to skip the change silently.

### Patch Changes

- @notation/core@0.14.0
- @notation/dashboard@0.14.0
- @notation/esbuild-plugins@0.14.0

## 0.13.0

### Minor Changes

- b7119a8: Add durable Yieldstar 0.5.0 deploy and destroy workflows, a resident Node SQLite runtime for CLI execution, versioned event streams, backend-neutral dashboard state, and compiled infrastructure graphs.
- f7e9186: A resource `read` now returns the remote object or throws the tagged `ResourceNotFoundError`. Operations that have started but not settled throw `ResourceOperationPendingError` with their retry delay and optional callback context. The reconciler follows those explicit instructions instead of guessing retry behaviour from provider errors or call-site context.

### Patch Changes

- Updated dependencies [b7119a8]
- Updated dependencies [f7e9186]
  - @notation/core@0.13.0
  - @notation/dashboard@0.13.0
  - @notation/esbuild-plugins@0.13.0

## 0.12.0

### Minor Changes

- Add `notation plan` command backed by a serializable `Plan` and
  `Reconciler.plan()`, surfacing the deploy/destroy operations a run would
  perform before executing them.

  Also bumps dependencies to clear all outstanding security advisories and
  upgrades the core toolchain: TypeScript 6, Vite 8, Vitest 4, and glob 13.

### Patch Changes

- Updated dependencies
  - @notation/core@0.12.0
  - @notation/dashboard@0.12.0
  - @notation/esbuild-plugins@0.12.0

## 0.11.1

### Patch Changes

- Hide large buffers from state file
- Updated dependencies
  - @notation/core@0.11.1
  - @notation/dashboard@0.11.1
  - @notation/esbuild-plugins@0.11.1

## 0.11.0

### Patch Changes

- @notation/core@0.11.0
- @notation/dashboard@0.11.0
- @notation/esbuild-plugins@0.11.0

## 0.10.0

### Minor Changes

- Fix package versions

### Patch Changes

- Updated dependencies
  - @notation/core@0.10.0
  - @notation/dashboard@0.10.0
  - @notation/esbuild-plugins@0.10.0

## 0.9.1

### Patch Changes

- Updated dependencies
  - @notation/core@0.6.1
  - @notation/dashboard@0.3.0
  - @notation/esbuild-plugins@0.6.1

## 0.9.0

### Minor Changes

- Fix dashboard

### Patch Changes

- Updated dependencies
  - @notation/dashboard@0.3.0

## 0.8.0

### Minor Changes

- Support externally managed lambda modules

### Patch Changes

- Updated dependencies
  - @notation/esbuild-plugins@0.6.0

## 0.7.0

### Minor Changes

- 2a6fc59: Add optional JWT authorizer config to route resource

### Patch Changes

- Handle missing credentials
- Updated dependencies [2a6fc59]
  - @notation/esbuild-plugins@0.5.0
  - @notation/core@0.6.0
  - @notation/dashboard@0.2.0

## 0.6.2

### Patch Changes

- Fix updating std.zip resource
- Updated dependencies
  - @notation/core@0.5.1
  - @notation/dashboard@0.2.0
  - @notation/esbuild-plugins@0.4.2

## 0.6.1

### Patch Changes

- Updated dependencies [5debdd1]
  - @notation/dashboard@0.2.0
  - @notation/core@0.5.0
  - @notation/esbuild-plugins@0.4.1

## 0.6.0

### Minor Changes

- Load infra in runtime modules

### Patch Changes

- 10a8133: Migrate project scaffolding to create-notation
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @notation/dashboard@0.1.0
  - @notation/esbuild-plugins@0.4.0
  - @notation/core@0.4.1

## 0.5.0

### Minor Changes

- Stateful deployments

### Patch Changes

- Updated dependencies
  - @notation/core@0.4.0
  - @notation/esbuild-plugins@0.3.2

## 0.4.2

### Patch Changes

- Fix tsconfig and getting started instruction

## 0.4.1

### Patch Changes

- 3b82ef1: Include templates in package bundle

## 0.4.0

### Minor Changes

- b75f89b: Add create app command

### Patch Changes

- Updated dependencies [b75f89b]
  - @notation/core@0.3.1
  - @notation/esbuild-plugins@0.3.1

## 0.3.0

### Minor Changes

- Prepare for release

### Patch Changes

- Updated dependencies
  - @notation/core@0.3.0
  - @notation/esbuild-plugins@0.3.0
