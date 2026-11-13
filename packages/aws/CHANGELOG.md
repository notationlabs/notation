# @notation/aws

## 0.18.0

### Patch Changes

- Updated dependencies [968e03d]
  - @notation/resource@0.18.0
  - @notation/core@0.18.0
  - @notation/std@0.18.0
  - @notation/utils@0.18.0

## 0.17.0

### Minor Changes

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

- 0da62b4: EventBridge rules can now send the events on an event bus to a Lambda function, and `eventBridge.schema()` takes a schema for the event's detail.

  ```ts
  import {
    $lambda,
    eventBridge,
    type LambdaHandler,
  } from "@notation/aws/lambda";
  import { ordersBus } from "infra/orders";
  import { OrderPlaced } from "shared/schema";

  export const lambda = $lambda({
    id: "fulfil-order",
    event: () =>
      eventBridge.bind(ordersBus).defineRule({
        id: "order-placed",
        pattern: { source: ["shop"], "detail-type": ["OrderPlaced"] },
        schema: OrderPlaced,
      }),
  });

  export const handler: LambdaHandler<typeof lambda> = async (event) => {
    const { detail: order } = await lambda.decode(event);
  };
  ```

  - `eventBus({ id, name })` in `@notation/aws/event-bridge` declares a custom event bus, named `<app>--<stage>--<id>`. `defaultEventBus()` returns the account's default bus, which Notation reads and never changes or deletes. Each call returns the same bus. Both have the output refs `arn` and `name`, and `grant(["PutEvents"])`. In a function, the runtime build replaces a bus with `{}`. Changing a bus's `name` replaces the bus: deploy deletes the rules on it, replaces the bus, and creates the rules again. Other resources that depend on the bus, such as a function whose `env` holds the bus's name, are updated in place. This also works when the same deploy removes the last rule in code: deploy loads the class of the old rule from the provider package that its state record names.
  - `eventBridge.bind(bus).defineRule({ id, name, pattern, schema, enabled, retry })` makes a rule on the bus that sends the events that match `pattern` to the function, and the permission that lets the rule invoke it. `rule({ id, name, pattern, enabled, retry, bus, target })` makes the same rule from infra, for a declaration with `eventBridge.schema(schema)`, a declaration with no event, or a Lambda group. `rule()` takes no schema, as the function's declaration names it. `rule()` throws for a declaration with `eventBridge.schema(null)`, and for a declaration that makes its own rule.
  - `schema` is required in `defineRule()`. A rule whose events can have any detail declares a schema such as `v.unknown()`. A pattern with no fields throws.
  - `enabled: false` disables the rule. `retry: { maxAttempts, maxEventAge }` sets the target's retry policy.
  - No two EventBridge rules or schedules in a deployment can have the same AWS name, even on different buses.
  - `eventBridge.schema(schema)` declares a function that receives the events of rules that infra makes. `eventBridge.schema(null)` still declares a function that receives scheduled events. `schedule()` throws for a declaration with a detail schema, and TypeScript rejects it.
  - `decode(event)` validates the event's `detail` with the schema, and returns the event with `detail` typed as the schema's output. A `DecodeError` for the detail has the `part` `"detail"`. A function of scheduled events still has no `decode()`.
  - `LambdaHandler<typeof lambda>` types the event of a rule as `EventBridgeEvent<string, unknown>`.
  - `EventBridgeRuleEvent<S>` is the event type of `eventBridge`. `EventBridgeScheduleEvent` is now `EventBridgeRuleEvent<null>`, and has `schema: null`. `ScheduleConfig.target` is a `ScheduleTarget`, which is `RuleTarget<null>`.
  - `@notation/aws/resources` adds `eventBridge.EventBus` and `eventBridge.DefaultEventBus`. `eventBridge.EventBridgeRule` takes a `State`, and an optional `eventBus` dependency, and blocks the delete of an `EventBus`. It sends and reads `EventPattern` in compact JSON, so a pattern that config holds in another layout is not reported as drift.

- 5c0470c: Lambda functions no longer reserve concurrency by default. `$lambda()` and `lambda()` take a `concurrency` option, which adds a `lambda.LambdaFunctionConcurrency` resource that sets the function's reserved concurrency. Versions after `@notation/aws.iac` 0.5.0 applied no reservation, so their functions need no action. A function first deployed by 0.5.0 or earlier keeps a reserved concurrency of 1 until you remove it with `aws lambda delete-function-concurrency`. The deploy role needs `lambda:PutFunctionConcurrency`, `lambda:DeleteFunctionConcurrency` and `lambda:GetFunctionConcurrency` only for functions that set `concurrency`.
- 99baac9: `@notation/aws/resources` adds `lambda.LambdaPermission`, a statement in a function's resource policy that lets a service invoke the function. It replaces `lambda.LambdaApiGatewayV2Permission` and `eventBridge.LambdaEventBridgeRulePermission`, which are removed with their `Schema`, `Dependencies` and `Instance` types.

  - `LambdaPermission` takes `Action`, `Principal` (a service, such as `events.amazonaws.com`) and an optional `SourceArn`, and depends on the function.
  - Its `StatementId` comes from its resource ID. An ID that has characters other than letters, digits, `-` and `_`, or that is longer than 100 characters, ends in a hash of the full ID.
  - `read` finds the statement with `GetPolicy`, so deploy detects a statement removed outside Notation.
  - The API Gateway API resource has a new output, `ExecuteApiSourceArn`.
  - In `@notation/aws`, API routes, schedules and EventBridge rules use `LambdaPermission`.
  - State written by an earlier version is not supported. Its permission records have the removed types under the IDs that `LambdaPermission` now uses. Destroy the stack with the earlier version before you upgrade.

- 8839f28: `resource.outputValue(key)` is now `resource.outputRef(key)`. It returns an object that names a resource and one of its outputs, and does not hold the output, so the old name was misleading. The exports from `@notation/resource` are renamed to match:

  - `OutputValue` is now `OutputRef`.
  - `OutputValueStringError` is now `OutputRefStringError`.
  - `isOutputValue`, `containsOutputValue` and `resolveOutputValues` are now `isOutputRef`, `containsOutputRef` and `resolveOutputRefs`.

- a7f5459: `json` is removed from `@notation/aws/lambda.fn`. An API handler can return a plain value, such as an object or an array, and API Gateway sends it as a JSON body with status 200. `ApiGatewayResult` from `@notation/aws/lambda` types what an API handler returns.
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

- 73e7ace: Every resource that you declare takes a required `id`, as `$lambda` and `lambda()` already do. The `id` keys the resource in state, and Notation builds the AWS name from it.

  ```ts
  const ordersQueue = queue({ id: "orders", schema: Order });
  const userApi = api({ id: "user-api" });
  const userAuth = jwtAuthorizer({
    id: "user-auth",
    api: userApi,
    issuer,
    audience,
  });
  schedule({ id: "nightly", schedule: rate(1, "day"), target: () => lambda });
  ```

  - `queue()`, `api()`, `schedule()` and `eventBridge.defineSchedule()` take `id` in place of `name`. `jwtAuthorizer()` takes a new required `id`.
  - An `id` has 1 to 64 letters, digits, hyphens or underscores, and must be a string literal. TypeScript reports an `id` that breaks the rule, and the function throws on one when infra runs. `NameSafe` and `isNameSafe` check the rule. `LAMBDA_ID_MAX_LENGTH` is renamed `ID_MAX_LENGTH`.
  - A queue, an API, an authorizer, a schedule and a Lambda function take an optional `name`, which replaces the `id` in the AWS name. The `<app>--<stage>--` prefix stays, so `queue({ id: "orders", name: "order-events" })` is named `<app>--<stage>--order-events`. A function's `name` sets only the function's name, and its role keeps the name from the `id`. A `name` has the same characters as an `id`.
  - A FIFO queue no longer needs `.fifo` in its name. Notation adds `.fifo` to the AWS name of a queue with `fifo: true`.
  - An authorizer's state key is its API's `id` and its own `id`, such as `api-authorizer:todo-api:user-auth`, not a hash of its issuer and audience. Two APIs can each have an authorizer with the same `id`. Changing the issuer or audience updates the authorizer in place. Two authorizers on one API with the same issuer and audience are allowed when their IDs differ. In AWS, the authorizer is named after its `id`, or its `name`, with no prefix, because its API's name has the prefix already. The old AWS name was `${apiId}_jwt_<hash>`, and the new one is `name ?? id`, so the next deploy replaces each existing authorizer.
  - Every state key changes. A resource's state key is now a type prefix and the IDs that the resource belongs to, joined with `:`, such as `lambda:orders`, `lambda:orders:role`, `sqs-queue:orders`, `sqs-mapping:orders:process-orders`, `api:todo-api`, `api-route:todo-api:GET /todos`, `api-integration:todo-api:todos`, `api-authorizer:todo-api:user-auth` and `eventbridge-rule:nightly`. Before, keys such as `orders-queue` and `todo-api-GET-/todos` joined IDs with `-`, so an API and a Lambda with the same `id` got the same key, and queue `a` with Lambda `b-c` got the same mapping key as queue `a-b` with Lambda `c`. An `id` can't contain `:`, so keys can no longer collide. State from an earlier version doesn't match the new keys: destroy a deployment with the earlier version before you upgrade, or expect the next deploy to try to create every resource again.
  - Two Lambda functions, two queues or two EventBridge rules in one deployment can't have the same AWS name, and two authorizers of one API can't either. For example, `$lambda({ id: "a", name: "b" })` and `$lambda({ id: "b" })` both name a function `<app>--<stage>--b`. Infra throws when it runs, and the error names both declarations. An invalid `name` or a duplicate `id` of a `$lambda` is reported as coming from `$lambda`, not `lambda()`.
  - A Lambda permission's `StatementId` is `apigateway-<api id>` for an API, and `events-<rule name>` for an EventBridge rule. Before, a function routed from two APIs, or on two schedules, got two statements with the same ID, and `AddPermission` failed.

- 1cce9df: The AWS resource classes move from `@notation/aws.iac` to `@notation/aws/resources`. The standard resource classes move from `@notation/std.iac` to `@notation/std/resources`. `@notation/aws.iac` and `@notation/std.iac` are no longer published.

  ```ts
  import { lambda, sqs } from "@notation/aws/resources";
  import { fs } from "@notation/std/resources";
  ```

  - A provider is a package or a package subpath, such as `@notation/aws/resources`. Deploy and destroy register each resource class among the entry's exports and among the values of each exported namespace, if the class declares that provider. Other exports are ignored.
  - A provider name can contain only letters, digits, `_`, `.`, `~` and `-`, with `@` before a scope and `/` between segments. A segment can't start with a dot.
  - `resourceClasses` is removed from both packages, and `resourceClassesIn` is removed from `@notation/resource`.
  - `@notation/aws/shared` is removed. The handler types, such as `ApiGatewayHandler`, `SqsHandler` and `APIGatewayJWTProxyEventV2`, are exported from `@notation/aws/lambda`. `AwsResourceGroup` is no longer exported.

- 5b4d14c: `queue()` takes a dead-letter queue, a message size and the FIFO settings, and SQS mappings can report failed messages and limit concurrency.

  ```ts
  export const orderDeadLetterQueue = queue({
    id: "orders-dlq",
    schema: DeadLetter,
  });

  export const orderQueue = queue({
    id: "orders",
    schema: Order,
    deadLetterQueue: { queue: orderDeadLetterQueue, maxReceiveCount: 3 },
  });

  export const lambda = $lambda({
    id: "orders",
    event: () => sqs.bind(orderQueue, { reportBatchItemFailures: true }),
  });
  ```

  - `deadLetterQueue: { queue, maxReceiveCount }` sets the queue's `RedrivePolicy`. `queue` is a queue from `queue()`, which then deploys first, or the ARN of a queue that Notation doesn't manage. `queue()` throws when one queue is FIFO and the other is standard. Removing `deadLetterQueue` removes the policy.
  - `maximumMessageSize` sets `MaximumMessageSize`. Removing it sets the queue back to 1,048,576 bytes.
  - `contentBasedDeduplication`, `deduplicationScope` and `fifoThroughputLimit` set the FIFO attributes of the same names. `queue()` throws when a standard queue sets one of them, and when `fifoThroughputLimit: "perMessageGroupId"` comes without `deduplicationScope: "messageGroup"`. Removing one sets it back to the SQS default.
  - **Breaking:** the mapping option `maxBatchingWindow` is now `maximumBatchingWindow`, to follow the AWS name `MaximumBatchingWindowInSeconds`. Rename it in each `sqs.bind()` and `eventSourceMapping()` call.
  - `sqs.bind()` and `eventSourceMapping()` take `reportBatchItemFailures`, `maximumConcurrency` and `enabled`. `reportBatchItemFailures: true` turns on `ReportBatchItemFailures`, so Lambda reads `{ batchItemFailures }` from the handler's result. For `sqs.bind()`, `LambdaHandler` allows that result only when the option is `true`. `maximumConcurrency` sets the mapping's `ScalingConfig`. `enabled: false` pauses the mapping. Removing an option sets the mapping back to the Lambda default.
  - In `@notation/aws/resources`, `sqs.Queue` takes `MaximumMessageSize`, `RedrivePolicy`, `RedriveAllowPolicy`, `ContentBasedDeduplication`, `DeduplicationScope` and `FifoThroughputLimit`. `lambda.LambdaEventSourceMapping` takes `FunctionResponseTypes` and `ScalingConfig`.

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
- f490162: `perCollection(key, create)` keeps one value for each resource graph that is being collected, so that two graphs collected in one process don't see each other's declarations. It returns `undefined` when no graph is being collected. `@notation/aws` now keeps its claimed AWS names and the default event bus with it. `@notation/cloudflare` uses it too.
- 3fefade: `@notation/aws`, `@notation/std`, `@notation/resource` and `@notation/utils` declare `"sideEffects": false`. A bundler can now drop these packages from a Lambda bundle when the runtime code doesn't use them.

  `@notation/aws/resources` constructs each AWS SDK client when it is first used, not when the module loads. `@notation/aws/resources` and `@notation/std/resources` import the project path helpers from the new `@notation/core/paths` subpath, so they no longer load the deploy engine, esbuild, pino and yieldstar.

  The starter template sets `"types": ["node"]` and installs `@types/node`. It used to get the Node types through `@notation/core`.

- Updated dependencies [ae3d823]
- Updated dependencies [614ce3f]
- Updated dependencies [ce76cd5]
- Updated dependencies [ce76cd5]
- Updated dependencies [d93d65a]
- Updated dependencies [d00b769]
- Updated dependencies [9d669fc]
- Updated dependencies [35206ce]
- Updated dependencies [8839f28]
- Updated dependencies [f490162]
- Updated dependencies [e9da750]
- Updated dependencies [e4f4157]
- Updated dependencies [f490162]
- Updated dependencies [7eb8766]
- Updated dependencies [1cce9df]
- Updated dependencies [ce76cd5]
- Updated dependencies [3fefade]
- Updated dependencies [ce76cd5]
- Updated dependencies [121442b]
- Updated dependencies [4776f9f]
- Updated dependencies [6cec012]
- Updated dependencies [f490162]
  - @notation/core@0.17.0
  - @notation/resource@0.17.0
  - @notation/std@0.17.0
  - @notation/utils@0.17.0

## 0.16.0

### Minor Changes

- 19a9d2e: SQS queues:

  - `queue({ name })` from `@notation/aws/sqs` creates a queue, with `arn` and `url` output values.
  - `queue.consume(handler)` invokes a function with the queue's messages. It grants the function's role read access and creates an event source mapping.
  - `queue.grant(actions)` returns a policy statement for the queue.

  Lambda:

  - A Lambda group's `policy` is an inline role policy that other code adds statements to. The group creates it the first time code reads `policy`.
  - A Lambda group exposes its `role`.
  - `Environment` is collected and merged key by key.

  `@notation/aws.iac` adds `lambda.LambdaRolePolicy`, `lambda.LambdaEventSourceMapping` and `sqs.Queue`.

- 5ed5981: Routes on one API with the same JWT issuer and audience share one authorizer instead of one authorizer per route. The authorizer ID changes from `<route id>-<api>-authorizer` to `<api>-jwt-authorizer-<hash>`, and its name from `<api>_<method>_<path>_authorizer` to `<api>_jwt_<hash>`. On the first deploy after the upgrade, each API creates the shared authorizer, points its routes at it and deletes the per-route authorizers. An API that already has 10 authorizers fails the create, because the old authorizers are deleted after it. Ask AWS Support to raise the quota for that API before the upgrade.

### Patch Changes

- Updated dependencies [19a9d2e]
- Updated dependencies [19a9d2e]
- Updated dependencies [7d01d51]
  - @notation/aws.iac@0.16.0
  - @notation/resource@0.16.0
  - @notation/std.iac@0.16.0

## 0.15.0

### Minor Changes

- bddd9f8: `ResourceGroup.dependencies` and the `dependencies` option of `ResourceGroupOptions` have been removed. Nothing read them, and they could disagree with the actual graph. Edges between groups follow from the dependencies of the resources they contain, since each resource records its group.
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

- Updated dependencies [bddd9f8]
- Updated dependencies [18c2b4c]
- Updated dependencies [91806d0]
- Updated dependencies [41f2a02]
- Updated dependencies [83f0de1]
- Updated dependencies [16a0209]
- Updated dependencies [b290eb1]
- Updated dependencies [4fe4451]
- Updated dependencies [f150ec6]
- Updated dependencies [7a90e6b]
- Updated dependencies [6508511]
- Updated dependencies [6943418]
  - @notation/resource@0.15.0
  - @notation/aws.iac@0.15.0
  - @notation/std.iac@0.15.0

## 0.14.0

### Patch Changes

- Updated dependencies [9afdb3c]
  - @notation/resource@0.14.0
  - @notation/aws.iac@0.14.0
  - @notation/std.iac@0.14.0

## 0.13.0

### Minor Changes

- b7119a8: Add durable Yieldstar 0.5.0 deploy and destroy workflows, a resident Node SQLite runtime for CLI execution, versioned event streams, backend-neutral dashboard state, and compiled infrastructure graphs.

### Patch Changes

- Updated dependencies [b7119a8]
- Updated dependencies [f7e9186]
  - @notation/aws.iac@0.13.0
  - @notation/resource@0.13.0
  - @notation/std.iac@0.13.0

## 0.12.0

### Patch Changes

- Updated dependencies
  - @notation/core@0.12.0
  - @notation/aws.iac@0.12.0
  - @notation/std.iac@0.12.0
  - @notation/resource@0.12.0

## 0.11.1

### Patch Changes

- Hide large buffers from state file
- Updated dependencies
  - @notation/aws.iac@0.11.1
  - @notation/core@0.11.1
  - @notation/std.iac@0.11.1

## 0.11.0

### Minor Changes

- 5dcb935: Support alternative runtimes

### Patch Changes

- Updated dependencies [5dcb935]
  - @notation/aws.iac@0.11.0
  - @notation/core@0.11.0
  - @notation/std.iac@0.11.0

## 0.10.0

### Minor Changes

- Fix package versions

### Patch Changes

- Updated dependencies
  - @notation/aws.iac@0.10.0
  - @notation/core@0.10.0
  - @notation/std.iac@0.10.0

## 0.7.1

### Patch Changes

- Updated dependencies
  - @notation/core@0.6.1
  - @notation/aws.iac@0.6.1
  - @notation/std.iac@0.6.1

## 0.7.0

### Minor Changes

- Support externally managed lambda modules

### Patch Changes

- Updated dependencies
  - @notation/aws.iac@0.6.0
  - @notation/std.iac@0.6.0

## 0.6.0

### Minor Changes

- 2a6fc59: Add optional JWT authorizer config to route resource

### Patch Changes

- Updated dependencies [2a6fc59]
  - @notation/aws.iac@0.5.0
  - @notation/std.iac@0.5.0
  - @notation/core@0.6.0

## 0.5.3

### Patch Changes

- Fix updating std.zip resource
- Updated dependencies
  - @notation/aws.iac@0.4.3
  - @notation/core@0.5.1
  - @notation/std.iac@0.4.3

## 0.5.2

### Patch Changes

- Fix types

## 0.5.0

### Minor Changes

- 5debdd1: Show deployed resource state in dashboard

### Patch Changes

- Updated dependencies [5debdd1]
  - @notation/core@0.5.0
  - @notation/aws.iac@0.4.2
  - @notation/std.iac@0.4.2

## 0.4.1

### Patch Changes

- Removed dev artifacts from dist
- Updated dependencies
  - @notation/aws.iac@0.4.1
  - @notation/core@0.4.1
  - @notation/std.iac@0.4.1

## 0.4.0

### Minor Changes

- Stateful deployments

### Patch Changes

- Updated dependencies
  - @notation/aws.iac@0.4.0
  - @notation/core@0.4.0
  - @notation/std.iac@0.4.0

## 0.3.1

### Patch Changes

- Updated dependencies [b75f89b]
  - @notation/core@0.3.1
  - @notation/aws.iac@0.3.1
  - @notation/std.iac@0.3.1

## 0.3.0

### Minor Changes

- Prepare for release

### Patch Changes

- Updated dependencies
  - @notation/aws.iac@0.3.0
  - @notation/core@0.3.0
  - @notation/std.iac@0.3.0
