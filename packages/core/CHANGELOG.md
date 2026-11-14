# @notation/core

## 0.21.0

### Patch Changes

- Updated dependencies [c290823]
- Updated dependencies [ce4a9e1]
  - @notation/resource@0.21.0
  - @notation/reconciler@0.21.0
  - @notation/state@0.21.0
  - @notation/utils@0.21.0

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

- Updated dependencies [aa8eea2]
- Updated dependencies [a9e3fe4]
  - @notation/resource@0.20.0
  - @notation/reconciler@0.20.0
  - @notation/utils@0.20.0
  - @notation/state@0.20.0

## 0.19.0

### Patch Changes

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
- Updated dependencies [e41a52e]
  - @notation/reconciler@0.19.0
  - @notation/state@0.19.0
  - @notation/resource@0.19.0

## 0.18.0

### Patch Changes

- Updated dependencies [968e03d]
  - @notation/resource@0.18.0
  - @notation/reconciler@0.18.0
  - @notation/state@0.18.0

## 0.17.0

### Minor Changes

- ce76cd5: The compiler is built on Rolldown, in place of esbuild (RFC 0015). `@notation/esbuild-plugins` is replaced by `@notation/build`.

  - The builds find declaration functions by JSDoc marks in the packages that export them. `@declaration` marks a function that declares a function resource, such as `$lambda`, with the options that each build keeps. `@resource` marks a resource function, such as `queue`. `@resource runtime: schema` lists the options of the resource that a function reads. `@resource runtime:` with no options means the resource becomes `{}` in the function. The builds follow imports, re-exports and `export *` to the module that has the mark.
  - A declaration is written `const name = $lambda({ ... })` at the top level of its module, with an object literal that has no spread or computed keys. Any other call fails the build with its location, and so does a module with more than one declaration. A function that the user marks `@declaration` can call a declaration function inside it.
  - The infra build runs a stripped copy of each declaration module that the infra entry reaches. The copy keeps the declaration and the top-level statements that it uses. The handler, SDK clients, top-level `await`, logging and side-effect imports are removed. The declaration is wrapped in `__notation_declaredIn(...)`, which records the module's path, relative to the project root, and the name of its binding. The build fails if the module doesn't export `handler`, or if another module imports a name that the copy doesn't keep.
  - The runtime build bundles each declaration module to `dist/<module path>/index.mjs`, from a generated entry that re-exports `handler`. The declaration keeps only the options that the function uses: `id`, `event`, and the names of `env` without their values. An import whose uses the strip removed is removed too, so the bundle doesn't load the module it imports from, with or without `verbatimModuleSyntax`. Infra modules are marked free of side effects, so the bundler drops them when another module imports them. The build fails if a kept option refers to an infra module, or if an infra module or an infra function from a package, such as `queue()`, is still in the bundle. The error names the import chain from the function's module, and each use.
  - A resource from an infra module that a kept option names, such as `ordersQueue` in `sqs.bind(ordersQueue)`, becomes an object of the resource's runtime options in the runtime build: `sqs.bind({ schema: Order })`. Each option is imported from where infra imports it, which must be a shared module, a package, or a file that no glob matches and that calls no resource function at its top level. Each option must be a name that infra imports by name or as a default import, and not a member such as `schemas.Order` or an expression such as `Order.extend({ ... })`. The build fails if the resource is not a call to a resource function with an object literal, if the literal has a spread in place of a runtime option, written as a top-level const or in an object literal. The build can't tell a resource that a helper makes from a plain value, such as a schema, so the error says to declare a resource with a call to its resource function, and to move a plain value to a shared module. A resource marked with a bare `@resource` is not replaced, and gets the error for an infra value.
  - The strip follows `export default queue({ ... })` to the resource, and stops at an `export *` that leads back to a module it has visited. A resource that a `let` holds fails the build with the error for an infra value. A const of the function's module that holds a resource, such as `const local = ordersQueue`, fails the build with an error that says to pass the resource directly. A name that a local binding shadows, such as `q` in `(q) => sqs.bind(q)`, is left as it is. Added imports go after a hashbang line.
  - Packages stay external in the infra bundle, as before. Imports through tsconfig `paths` are bundled.
  - `compileInfra()` returns the declaration modules, as `{ path, binding, entry }`.

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

- 1cce9df: The AWS resource classes move from `@notation/aws.iac` to `@notation/aws/resources`. The standard resource classes move from `@notation/std.iac` to `@notation/std/resources`. `@notation/aws.iac` and `@notation/std.iac` are no longer published.

  ```ts
  import { lambda, sqs } from "@notation/aws/resources";
  import { fs } from "@notation/std/resources";
  ```

  - A provider is a package or a package subpath, such as `@notation/aws/resources`. Deploy and destroy register each resource class among the entry's exports and among the values of each exported namespace, if the class declares that provider. Other exports are ignored.
  - A provider name can contain only letters, digits, `_`, `.`, `~` and `-`, with `@` before a scope and `/` between segments. A segment can't start with a dot.
  - `resourceClasses` is removed from both packages, and `resourceClassesIn` is removed from `@notation/resource`.
  - `@notation/aws/shared` is removed. The handler types, such as `ApiGatewayHandler`, `SqsHandler` and `APIGatewayJWTProxyEventV2`, are exported from `@notation/aws/lambda`. `AwsResourceGroup` is no longer exported.

- ce76cd5: Runtime modules are found by their declaration, such as `$lambda`, in the files that `files.runtime` in `notation.config.ts` matches. The default is `runtime/**`. This replaces the fixed `runtime/**/*.fn.ts` glob, so a runtime module's file name doesn't need a `.fn` ending. The starter's runtime module is `runtime/todos.ts`.
- 3fefade: `@notation/aws`, `@notation/std`, `@notation/resource` and `@notation/utils` declare `"sideEffects": false`. A bundler can now drop these packages from a Lambda bundle when the runtime code doesn't use them.

  `@notation/aws/resources` constructs each AWS SDK client when it is first used, not when the module loads. `@notation/aws/resources` and `@notation/std/resources` import the project path helpers from the new `@notation/core/paths` subpath, so they no longer load the deploy engine, esbuild, pino and yieldstar.

  The starter template sets `"types": ["node"]` and installs `@types/node`. It used to get the Node types through `@notation/core`.

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
- d93d65a: Deploy now includes runtime modules that infra doesn't import. The infra build reads each file that `files.runtime` in `notation.config.ts` matches. The infra bundle imports the entry first, and then each of these files that calls a declaration function, such as `$lambda`. A file without a declaration is not imported.

  - In watch mode, the base directory of each `files.runtime` glob is watched, or its nearest existing parent, so a new runtime file is deployed without a restart.
  - The scan and the infra watcher skip `dist/`, `node_modules/` and dot-directories at any depth.
  - A file in the globs that can't be parsed fails the build, and the error names the file.

- 35206ce: The durable runtime package is now `@notation/durable` 0.9.0. It replaces `yieldstar`, `@yieldstar/core` and `@yieldstar/sqlite-runtime`. An application that composes `deploy` or `destroy` in its own workflow must import from `@notation/durable` instead:

  - `yieldstar` becomes `@notation/durable`.
  - `@yieldstar/core` becomes `@notation/durable/runtime`.
  - `@yieldstar/sqlite-runtime/node` becomes `@notation/durable/sqlite/node`.

- Updated dependencies [ae3d823]
- Updated dependencies [614ce3f]
- Updated dependencies [ce76cd5]
- Updated dependencies [d00b769]
- Updated dependencies [35206ce]
- Updated dependencies [8839f28]
- Updated dependencies [f490162]
- Updated dependencies [e9da750]
- Updated dependencies [e4f4157]
- Updated dependencies [f490162]
- Updated dependencies [7eb8766]
- Updated dependencies [aa5b5d9]
- Updated dependencies [1cce9df]
- Updated dependencies [3fefade]
- Updated dependencies [ce76cd5]
- Updated dependencies [121442b]
- Updated dependencies [4776f9f]
- Updated dependencies [6cec012]
- Updated dependencies [f490162]
  - @notation/reconciler@0.17.0
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
  - @notation/reconciler@0.16.0
  - @notation/state@0.16.0

## 0.15.0

### Minor Changes

- b290eb1: Resources and resource groups take their ID as their first argument, ahead of their options:

  ```ts
  // before
  new LambdaIamRole({ id: "todos-role", config: { RoleName: "todos-role" } });
  super("Lambda", { id: config.id, config });

  // after
  new LambdaIamRole("todos-role", { config: { RoleName: "todos-role" } });
  super("Lambda", config.id, config);
  ```

  - A resource's options can be left out when neither `config` nor `dependencies` has a required property: `new TestResource("a")`.
  - `ResourceGroup.addOnce` takes the ID separately: `group.addOnce(LambdaIntegration, id, { dependencies })`.
  - `ResourceOpts` no longer includes `id`.
  - `ResourceGroupOptions` is removed.

  The `@notation/aws` functions, such as `lambda({ id, ... })`, still take an object.

- 4fe4451: Paths are now relative to the project root (the nearest directory with a package.json, starting from the working directory), not the working directory. This covers deployment IDs, Lambda IDs, build output, the state database and the files that file and zip resources read. You can run the CLI from any folder inside the project and get the same result.

  This is a breaking change. Deployment IDs used to be absolute paths, so Notation will not find the state of existing deployments. Destroy them before upgrading, or redeploy and delete the old resources by hand.

- 7a90e6b: Resource groups now have stable string IDs. Previously, a group's ID was its position in the graph, so adding a group shifted the IDs of every group declared after it, and groups built outside a graph all had the ID `-1`.

  - `ResourceGroup` requires an `id`, a string that must be unique among groups of the same type. Declaring two groups with the same type and ID in one graph throws.
  - `LambdaGroup` uses the lambda's `id`, `ApiGroup` the API's `name`, `RouteGroup` `<api id>-<method>-<path>` and `ScheduleGroup` the schedule's `name`.
  - `ResourceGroup`'s `type`, `id`, `config` and `resources` are read-only.
  - Resources record their group as `resource.group`, a `{ type, id }` pair, or `null` if they are in no group. This replaces `groupId` and `groupType`, in memory and in persisted state. `@notation/resource` and `@notation/core` export the pair's type as `ResourceGroupRef`.
  - The dashboard labels groups by type and ID, such as `Lambda get-todos`, instead of by position.

  State written by earlier versions still loads, deploys and destroys. Its records keep `groupId` and `groupType` until their resource is next created or updated, and the dashboard lists them as ungrouped until then.

### Patch Changes

- 425f8ba: `notation viz` charts now render when resource or group names contain characters Mermaid can't use in IDs, such as an API name with a space or a route with a path parameter like `/todos/{id}`. Previously, such names made the chart fail to parse. Nodes and subgraphs now get IDs from their position in the chart, and their names go in quoted, escaped labels that show the type and ID, such as `Lambda get-todos`. Resources that are in no group are drawn too, outside every subgraph.
- 6943418: `diffParams` now puts each changed param in `patch` whole, rather than as a nested diff. Changing one Lambda environment variable no longer drops the others, removing all of them now clears them, and an EventBridge rule update no longer sends a rule with no name or targets keyed by index. `@notation/core` drops its unused `deep-object-diff` dependency.
- Updated dependencies [bddd9f8]
- Updated dependencies [18c2b4c]
- Updated dependencies [83f0de1]
- Updated dependencies [16a0209]
- Updated dependencies [b290eb1]
- Updated dependencies [7a90e6b]
- Updated dependencies [6508511]
- Updated dependencies [6943418]
  - @notation/resource@0.15.0
  - @notation/reconciler@0.15.0
  - @notation/state@0.15.0

## 0.14.0

### Patch Changes

- Updated dependencies [9afdb3c]
  - @notation/reconciler@0.14.0
  - @notation/resource@0.14.0
  - @notation/state@0.14.0

## 0.13.0

### Minor Changes

- b7119a8: Add durable Yieldstar 0.5.0 deploy and destroy workflows, a resident Node SQLite runtime for CLI execution, versioned event streams, backend-neutral dashboard state, and compiled infrastructure graphs.
- f7e9186: A resource `read` now returns the remote object or throws the tagged `ResourceNotFoundError`. Operations that have started but not settled throw `ResourceOperationPendingError` with their retry delay and optional callback context. The reconciler follows those explicit instructions instead of guessing retry behaviour from provider errors or call-site context.

### Patch Changes

- Updated dependencies [b7119a8]
- Updated dependencies [f7e9186]
  - @notation/reconciler@0.13.0
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

- Updated dependencies
  - @notation/reconciler@0.12.0
  - @notation/resource@0.12.0
  - @notation/state@0.12.0

## 0.11.1

### Patch Changes

- Hide large buffers from state file

## 0.11.0

## 0.10.0

### Minor Changes

- Fix package versions

## 0.6.1

### Patch Changes

- Remove log

## 0.6.0

### Minor Changes

- 2a6fc59: Add optional JWT authorizer config to route resource

## 0.5.1

### Patch Changes

- Fix updating std.zip resource

## 0.5.0

### Minor Changes

- 5debdd1: Show deployed resource state in dashboard

## 0.4.1

### Patch Changes

- Removed dev artifacts from dist

## 0.4.0

### Minor Changes

- Stateful deployments

## 0.3.1

### Patch Changes

- b75f89b: Clean up path method

## 0.3.0

### Minor Changes

- Prepare for release
