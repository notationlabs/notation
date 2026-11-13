# @notation/resource

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

- ce76cd5: A runtime module declares the Lambda function that it deploys as, next to the function's code (RFC 0015). The code is written with Lambda's own API, and the module exports `handler`.

  ```ts
  import { $lambda, sqs, type LambdaHandler } from "@notation/aws/lambda";
  import { ordersQueue, refundsQueue } from "../infra/orders";

  export const lambda = $lambda({
    id: "process-orders",
    event: () => sqs.bind(ordersQueue, { batchSize: 5 }),
    policy: () => [refundsQueue.grant(["SendMessage"])],
    env: () => ({ REFUNDS_QUEUE_URL: refundsQueue.url }),
  });

  export const handler: LambdaHandler<typeof lambda> = async (event) => {
    for (const record of event.Records) {
      const { body: order } = await lambda.decode(record);
    }
  };
  ```

  - `$lambda` in `@notation/aws/lambda` declares the function. It takes `id`, `name`, `event`, `env`, `policy`, `runtime`, `timeout` and `memory`.
  - `event` names the AWS service that sends the event. Each service has a function-led form, which makes the resource from the declaration, and an infra-led form, which infra wires: `sqs.bind(queue)` or `sqs.schema(schema)`, `apiGateway.bind(api).defineRoute({ method, path, schema, auth })` or `apiGateway.schema(body)`, and `eventBridge.defineSchedule({ id, schedule })` or `eventBridge.schema(null)`. A schema is any Standard Schema, and every event form has one. An infra-led form always takes a schema argument: `sqs.schema()` and `apiGateway.schema()` take a schema, and `apiGateway.schema(null)` declares a function whose requests have no body. The `schema` option of `defineRoute()` is required in the same way, with `schema: null` for no body. `eventBridge.schema()` takes only `null` for now, as a scheduled event has no detail to validate. The event kinds are `sqs`, `apiGateway`, `apiGateway-jwt` and `eventBridge`.
  - `queue()` takes a required `schema`, so `decode()` validates every SQS message. `queue({ id })` with no schema is a type error, and it throws when infra runs. A queue that takes any JSON body declares a schema such as `v.unknown()`, and `body` is the parsed JSON as `unknown`. Import the schema from a shared module (`files.shared`), as the function loads it.
  - `sqs` is an object with two methods, and it can't be called. `sqs.bind(queue, options)` maps the queue to the function, and `decode()` validates each message with the queue's schema. The options are `batchSize` and `maximumBatchingWindow`. `sqs.schema(schema)` declares a function that receives SQS messages from queues that infra maps to it with `eventSourceMapping()`, and `decode()` validates each message with `schema`.
  - `apiGateway.bind(api).defineRoute()` makes the route when the declaration is built. In the runtime build, the API becomes `{}` and an authorizer in `auth` becomes `{ claims }`. `router()` throws for such a declaration.
  - `jwtAuthorizer({ id, api, issuer, audience, scopes, claims })` in `@notation/aws/api-gateway` declares a JWT authorizer, which owns its API Gateway authorizer. `router(api).withAuthorizer(authorizer)` replaces `withJWTAuthorizer(config)`, and `JWTAuthorizerConfig` and `NO_AUTH` are removed. The routes of `withAuthorizer()` accept only a declaration with `apiGateway.schema(body).authSchema(claims)`, and check that its claims schema is the authorizer's, as an object at runtime and as a type. An authorizer with no claims schema accepts any. `.authSchema()` with no claims schema accepts any authorizer. A plain router's routes accept only a declaration with no `.authSchema()`.
  - `apiGateway.schema(body)` returns an event of the kind `apiGateway`. Its `authSchema(claims?)` method returns the event of the kind `apiGateway-jwt`.
  - `eventBridge.defineSchedule()` makes the rule and the permission when the declaration is built. `schedule()` throws for such a declaration.
  - `env` binds values by name. Deploy sets each one as an environment variable of the function. `lambda.env()` returns them, typed by name, and throws when one is not set. `env` must return an object literal with no spread or computed keys.
  - `lambda.decode(item)` parses the JSON body of an SQS record or an API Gateway request, and validates it with the event's schema. A request body is decoded from base64 if `isBase64Encoded` is set, then parsed as JSON, and the schema validates the parsed value. A body that is not JSON throws a `DecodeError`, so a route that takes text declares a string schema, and the client sends the text as a JSON string. Form and binary bodies are not supported yet. With a body schema, an empty body is validated as `undefined`. With a body schema of `null`, `body` is `undefined`, and a request with a body throws a `DecodeError`. It returns the item with `body` decoded, typed from the item that it receives. For a request through a JWT authorizer, it also returns the JWT claims as a top-level `claims` field, validated with the claims schema, or typed as `JwtClaims` with no claims schema. It leaves `requestContext` as API Gateway sent it, and the handler's event types the claims there as the loose `JwtClaims`. It throws a `DecodeError` when the body or the claims are not valid. The error's `part` is `"body"` or `"claims"`, and the claims are checked first.
  - `policy` adds statements to the function's role.
  - `LambdaHandler<typeof lambda>` types the handler from the event, and `LambdaEnv<typeof lambda>` types the bound variables.
  - `queue.consume()` is removed. Declare the function with `event: () => sqs.bind(queue)`, or map the queue in infra with `eventSourceMapping({ source: queue, target: () => lambda, batchSize })` from `@notation/aws/lambda`.
  - Infra wires the declaration as a function: `eventSourceMapping({ source, target: () => lambda })`, `router(api).get("/todos", () => lambda)` and `schedule({ id, schedule, target: () => lambda })`. A Lambda group from `lambda()` is passed as it is. The wiring runs when infra has finished loading, so a runtime module and the infra that wires it can import each other. `eventSourceMapping()`, `route()`, the router methods and `schedule()` return nothing.
  - Wiring a declaration whose event doesn't match fails: a queue needs an `sqs` Lambda, a route an `apiGateway` Lambda, and a schedule an `eventBridge` Lambda. A Lambda without `event` can be wired to any of them.
  - `eventSourceMapping()` fails for a declaration that maps a queue itself with `sqs.bind(queue)`, and for a declaration with `sqs.schema(schema)` when the queue's schema is another object than `schema`. `eventSourceMapping()` also takes a declaration with `sqs.schema()` only if its schema has the type of the queue's schema, so a mismatch is a type error. A declaration with no `event`, and a Lambda group from `lambda()`, can read any queue.
  - `schedule()` takes `target` in place of `handler`, and the rule sends the EventBridge event unchanged.
  - `APIGatewayJWTProxyEventV2<Claims>` in `@notation/aws/lambda` keeps the whole request context, and `TypedClaimsOverride` is removed.
  - The runtime build resolves `@notation/aws/lambda` to an entry without infra code, through the `notation-runtime` export condition.
  - Lambda IDs are 1 to 64 letters, digits, hyphens or underscores. `lambda()` takes `timeout` and `memory`, and `handler` defaults to `"handler"`.
  - `@notation/aws` recognises a Lambda group by a symbol, not by `instanceof`, so a group from another installed copy of the package passes its checks.
  - `LambdaFunction` in `@notation/aws/resources` collects `Environment.Variables` from several contributors. The deploy fails if the variables are over Lambda's 4 KB limit, and the error names the function.
  - `declaredIn` and `getDeclaredIn` in `@notation/resource` record and read the module of a declaration.

- 8839f28: `resource.outputValue(key)` is now `resource.outputRef(key)`. It returns an object that names a resource and one of its outputs, and does not hold the output, so the old name was misleading. The exports from `@notation/resource` are renamed to match:

  - `OutputValue` is now `OutputRef`.
  - `OutputValueStringError` is now `OutputRefStringError`.
  - `isOutputValue`, `containsOutputValue` and `resolveOutputValues` are now `isOutputRef`, `containsOutputRef` and `resolveOutputRefs`.

- f490162: `perCollection(key, create)` keeps one value for each resource graph that is being collected, so that two graphs collected in one process don't see each other's declarations. It returns `undefined` when no graph is being collected. `@notation/aws` now keeps its claimed AWS names and the default event bus with it. `@notation/cloudflare` uses it too.
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

- 1cce9df: The AWS resource classes move from `@notation/aws.iac` to `@notation/aws/resources`. The standard resource classes move from `@notation/std.iac` to `@notation/std/resources`. `@notation/aws.iac` and `@notation/std.iac` are no longer published.

  ```ts
  import { lambda, sqs } from "@notation/aws/resources";
  import { fs } from "@notation/std/resources";
  ```

  - A provider is a package or a package subpath, such as `@notation/aws/resources`. Deploy and destroy register each resource class among the entry's exports and among the values of each exported namespace, if the class declares that provider. Other exports are ignored.
  - A provider name can contain only letters, digits, `_`, `.`, `~` and `-`, with `@` before a scope and `/` between segments. A segment can't start with a dot.
  - `resourceClasses` is removed from both packages, and `resourceClassesIn` is removed from `@notation/resource`.
  - `@notation/aws/shared` is removed. The handler types, such as `ApiGatewayHandler`, `SqsHandler` and `APIGatewayJWTProxyEventV2`, are exported from `@notation/aws/lambda`. `AwsResourceGroup` is no longer exported.

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

- 4776f9f: `ResourceOperationPendingError` takes a `throttled` option. Set it to `true` when the provider refused the request because of a rate limit. A throttled `read` doesn't report that the resource exists: after a create with an unknown outcome, the reconciler looks the resource up again instead of recording the create as finished.
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
- d00b769: Plan treats a required output that is missing from a dependency's state record as unknown, as it does for a dependency that hasn't been created. A record written before an output was added to its resource type lacks the output. Before, plan read it as `undefined`, so a dependent's required param was missing, and plan and deploy failed before any change. Now the dependent's params that use the output are shown as unknown. Deploy reads the dependency again, fills in the output and then deploys the dependent.
- e9da750: Plan treats an output ref that `deriveParams` or a function contribution takes from a dependency, such as `deps.fn.outputRef("FunctionArn")`, as it treats any other output ref. When the dependency has no output, or its state record lacks the output, the param is shown as unknown. Before, plan failed with `PendingOutput`.
- 3fefade: `@notation/aws`, `@notation/std`, `@notation/resource` and `@notation/utils` declare `"sideEffects": false`. A bundler can now drop these packages from a Lambda bundle when the runtime code doesn't use them.

  `@notation/aws/resources` constructs each AWS SDK client when it is first used, not when the module loads. `@notation/aws/resources` and `@notation/std/resources` import the project path helpers from the new `@notation/core/paths` subpath, so they no longer load the deploy engine, esbuild, pino and yieldstar.

  The starter template sets `"types": ["node"]` and installs `@types/node`. It used to get the Node types through `@notation/core`.

- ce76cd5: Loading a second copy of `@notation/resource` now throws, with the paths of both copies. Each copy keeps its own resource graph, so resources made through the second copy were missing from the graph that plan and deploy read. Install one version, for example with `npm dedupe`.
- Updated dependencies [ae3d823]
- Updated dependencies [3fefade]
  - @notation/utils@0.17.0

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
  - @notation/utils@0.16.0

## 0.15.0

### Minor Changes

- bddd9f8: `ResourceGroup.dependencies` and the `dependencies` option of `ResourceGroupOptions` have been removed. Nothing read them, and they could disagree with the actual graph. Edges between groups follow from the dependencies of the resources they contain, since each resource records its group.
- 18c2b4c: Schema items no longer accept `defaultValue` or `propertyType: "derived"`. Nothing read either at runtime, so a `defaultValue` never filled in a missing param. Set the value in params, or compute it with `deriveParams`.
- 83f0de1: `ResourceGroup` now takes its config as its own argument: `super(type, id, config)`. Previously, every key except `id` and `dependencies` was collected into `group.config`, so a config with its own `id` or `dependencies` key lost it to the group.

  `ResourceGroup` and `AwsResourceGroup` take an optional type parameter for the config, so `group.config` is typed. `LambdaGroup`, `ApiGroup` and `ScheduleGroup` use it, and `LambdaGroup.config` is now the `LambdaConfig` itself rather than `{ config: LambdaConfig }`.

- 16a0209: Lambda functions now need an explicit, name-safe `id`. Notation no longer derives one from the handler name and a hash of the code's file path.

  - `lambda()` requires `id`. It must be name-safe: 1 to 59 letters (`A-Z`, `a-z`), digits, hyphens or underscores. These are the characters AWS allows in Lambda function names, and 59 leaves room for the `-role` suffix in the 64-character IAM role name. TypeScript rejects string literals that break the rule and values typed as plain `string`. At runtime, `lambda()` throws an error that names the bad ID.
  - The `config` export of a `.fn.ts` file requires `id`. Each handler gets the ID `<id>-<handler>`, which must also be name-safe. Compilation fails if `id` is missing or the resulting ID isn't name-safe.
  - Declaring two Lambda functions with the same ID in one deployment throws. IDs that differ only in case also clash, because IAM role names ignore case.
  - `@notation/aws/lambda` exports `NameSafe`, `isNameSafe` and `LAMBDA_ID_MAX_LENGTH`, and `@notation/resource` exports `getActiveResourceCollection`.

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

- 7a90e6b: Resource groups now have stable string IDs. Previously, a group's ID was its position in the graph, so adding a group shifted the IDs of every group declared after it, and groups built outside a graph all had the ID `-1`.

  - `ResourceGroup` requires an `id`, a string that must be unique among groups of the same type. Declaring two groups with the same type and ID in one graph throws.
  - `LambdaGroup` uses the lambda's `id`, `ApiGroup` the API's `name`, `RouteGroup` `<api id>-<method>-<path>` and `ScheduleGroup` the schedule's `name`.
  - `ResourceGroup`'s `type`, `id`, `config` and `resources` are read-only.
  - Resources record their group as `resource.group`, a `{ type, id }` pair, or `null` if they are in no group. This replaces `groupId` and `groupType`, in memory and in persisted state. `@notation/resource` and `@notation/core` export the pair's type as `ResourceGroupRef`.
  - The dashboard labels groups by type and ID, such as `Lambda get-todos`, instead of by position.

  State written by earlier versions still loads, deploys and destroys. Its records keep `groupId` and `groupType` until their resource is next created or updated, and the dashboard lists them as ungrouped until then.

- 6508511: Resource groups now expose their key resources as typed fields: `ApiGroup.api`, `LambdaGroup.fn`, `RouteGroup.route` and `ScheduleGroup.rule`. `api()`, `lambda()`, `route()` and `schedule()` return these classes, and route and schedule handlers are typed as `LambdaGroup`.

  `ResourceGroup.findResource` has been removed. Use the typed fields instead.

  `ResourceGroup.addOnce` adds a resource unless the group already has one with the same ID, and returns the one the group holds. Use it for resources that bind two others, such as an API integration, which several call sites may create.

  Two bugs are fixed:

  - When several APIs target the same Lambda function, each API now gets its own integration and invoke permission. Previously, every API reused the first API's integration, and the other APIs had no permission to invoke the function.
  - When several schedules target the same Lambda function, each schedule now gets its own invoke permission. Previously, only the first schedule got one, so the other schedules could not invoke the function.

### Patch Changes

- 6943418: `diffParams` now puts each changed param in `patch` whole, rather than as a nested diff. Changing one Lambda environment variable no longer drops the others, removing all of them now clears them, and an EventBridge rule update no longer sends a rule with no name or targets keyed by index. `@notation/core` drops its unused `deep-object-diff` dependency.

## 0.14.0

### Minor Changes

- 9afdb3c: The reconciler now replaces a resource when a change cannot be applied as an update: a change to an `immutable`, `primaryKey` or `secondaryKey` param, or any change to a resource with no `update` operation. Plans gain `replace` and `drift-replace` decisions with the `replaceFields` that force them, and `notation plan` marks replacements with `-/+`. A replacement deletes the resource and then creates it again, and its dependents plan against unknown params. The comparison lives in `diffParams` in `@notation/resource`, so any engine planning a Notation resource reaches the same decision. Drift now compares only fields present both remotely and in the desired params, and an unset param is treated as absent rather than unknown. The update operation now fails for a resource with no `update`, where it used to skip the change silently.

## 0.13.0

### Minor Changes

- b7119a8: Add durable Yieldstar 0.5.0 deploy and destroy workflows, a resident Node SQLite runtime for CLI execution, versioned event streams, backend-neutral dashboard state, and compiled infrastructure graphs.
- f7e9186: A resource `read` now returns the remote object or throws the tagged `ResourceNotFoundError`. Operations that have started but not settled throw `ResourceOperationPendingError` with their retry delay and optional callback context. The reconciler follows those explicit instructions instead of guessing retry behaviour from provider errors or call-site context.

## 0.12.0
