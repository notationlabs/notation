# AWS Internals

`@notation/aws` compiles high-level service declarations (`$lambda`, `api()`, `queue()`, `rule()`, `schedule()`) into resource primitives under `@notation/aws/resources`. It also strips infra expressions from runtime bundles and handles AWS SDK eventual consistency and partial failures.

## Resource groups

All AWS constructs extend `AwsResourceGroup` (`packages/aws/src/resource-group.ts`), which subclasses `ResourceGroup` with `platform = "aws"`:

```ts [packages/aws/src/resource-group.ts]
export class AwsResourceGroup<
  C extends Record<string, any> = Record<string, any>,
> extends ResourceGroup<C> {
  platform = "aws";
}
```

High-level groups validate IDs and cross-resource invariants during module evaluation or inside `whenLoaded` callbacks. This runs before the planner builds the resource graph (see [Resource Graph](./resource-graph.md)).

## Client initialization

SDK v3 clients are constructed lazily on first use rather than at import time. Offline commands (`notation compile`, `notation viz`) therefore never load AWS config files or fail when credentials are absent.

### Region enforcement

`region()` (`packages/aws/src/resources/config.ts`) reads `process.env.AWS_REGION` with no default fallback and throws immediately if unset.

### Lazy client cache

`lazy(create)` (`packages/aws/src/resources/utils/aws-clients.ts`) memoizes seven singleton client factories: `stsClient`, `cloudWatchLogsClient`, `lambdaClient`, `apiGatewayClient`, `iamClient`, `eventBridgeClient`, and `sqsClient`.

`getAwsAccountId()` (`packages/aws/src/resources/context.ts`) caches the `STSClient` `GetCallerIdentityCommand` promise for the process. It clears the cached promise on failure so transient errors can retry.

### Error classification

`awsCreate` (`packages/aws/src/resources/utils/errors.ts`) wraps resource `create` handlers to classify ambiguous failures:

- **Existing resource** – Errors matching an `alreadyExists` predicate become `ResourceAlreadyExistsError`.
- **Uncertain creation** – HTTP `5xx` statuses (`$metadata.httpStatusCode >= 500`), `TimeoutError`, or network error codes (`ECONNABORTED`, `ECONNRESET`, `EPIPE`, `ETIMEDOUT`) become `ResourceCreationUnknownError`. [Recovery](./recovery.md) then triggers `find` or `read` before retrying.

## Compiler stubs

During runtime bundling, `@notation/build` inspects `@declaration` and `@resource` JSDoc marks (see [Transforms](./transforms.md)). It strips infra-only imports and replaces resource references with minimal runtime stubs.

### Lambda declaration stripping

`$lambda` (`packages/aws/src/lambda/lambda-declaration.ts`) carries `@declaration shared: id, event, env; keys: env; entry: handler`:

| Option | Transform |
| :--- | :--- |
| `id` | Kept verbatim |
| `event` | Kept with bound infra resources replaced by `@resource runtime:` stubs |
| `env` | Retains only the returned object keys mapped to `undefined` |

Bound infra resources passed to `sqs.bind()`, `apiGateway.bind()`, or `eventBridge.bind()` inside `event` are replaced by their `@resource runtime:` stubs. `createRuntimeEnv` (`packages/aws/src/lambda/declaration.ts`) reads the retained `env` keys from `process.env` at invocation time.

Under the `"notation-runtime"` export condition, `@notation/aws/lambda` resolves to `packages/aws/src/lambda/runtime.ts`. There, `$lambda` attaches `createRuntimeEnv` and `createDecode`, while infra-only exports (`lambda()`, `LambdaGroup`, `eventSourceMapping()`) throw.

### Service stub shapes

When runtime code references an infra construct inside a kept option, the compiler replaces the call result according to its `@resource` mark:

| Construct | Stub |
| :--- | :--- |
| `api()` | `{}` |
| `eventBus()` | `{}` |
| `defaultEventBus()` | `{}` |
| `queue()` | `{ schema }` |
| `jwtAuthorizer()` | `{ claims }` |

`api()`, `eventBus()`, and `defaultEventBus()` carry `@resource runtime:`. `queue()` carries `@resource runtime: schema`, and `jwtAuthorizer()` carries `@resource runtime: claims` and falls back to `{}` when `claims` is omitted.

Bare `@resource` constructs (`lambda()`, `eventSourceMapping()`, `router()`, `route()`, `rule()`, `schedule()`) have no runtime stub and fail the build if referenced by a runtime handler.

## Naming rules

### Resource ID helpers

`resourceId(type, ...ids)` (`packages/aws/src/id.ts`) joins parts with `:`. Because declared IDs cannot contain `:`, distinct declarations never collide. Variable segments that may contain `:` (such as a route key) are placed last.

`nameBase(resourceId)` strips the leading `<type>:` prefix when deriving AWS physical names (see [Physical Names](./physical-names.md)).

### Name claim registry

`claimAwsName(kinds, name, declaration)` (`packages/aws/src/naming.ts`) stores claimed AWS names in a `perCollection("@notation/aws/awsNameClaims", ...)` map keyed by `` `${kinds}\n${name}` ``.

`JwtAuthorizerGroup` calls `claimAwsName` to reject duplicate authorizer names within the same API (`JWT authorizers of the API "<apiId>"`). When `name` is omitted, it defaults to `id`.

Separately, `assertUniqueLambdaId` checks active `ResourceGroup` instances for duplicate `LambdaGroup` IDs via `Symbol.for("@notation/aws/LambdaGroup")`.

## Child resource IDs

Each high-level construct populates deterministic child resource IDs in state (`resourceId(...)`).

### Lambda child resources

`LambdaGroup` (`packages/aws/src/lambda/lambda.ts`) registers these child resources for a function with ID `<id>`:

| Child ID | Resource |
| :--- | :--- |
| `lambda:<id>` | `aws.lambda.LambdaFunction` |
| `lambda:<id>:role` | `aws.lambda.LambdaIamRole` |
| `lambda:<id>:policy-attachment` | `aws.lambda.LambdaRolePolicyAttachment` |
| `lambda:<id>:role-policy` | `aws.lambda.LambdaRolePolicy` |
| `lambda:<id>:log-group` | `aws.lambda.LambdaLogGroup` |
| `lambda:<id>:zip` | `std.fs.Zip` or `std.fs.File` |
| `lambda:<id>:concurrency` | `aws.lambda.LambdaFunctionConcurrency` |

`lambda:<id>:policy-attachment` attaches `AWSLambdaBasicExecutionRole`, and `lambda:<id>:log-group` defaults to `retentionInDays: 30`. `lambda:<id>:role-policy` is added lazily via `addOnce` when `group.policy` is first read. `lambda:<id>:zip` uses `std.fs.Zip` for `code.type === "file"`, `std.fs.File` for `code.type === "zip"`, and is omitted for `BundleLike` inputs. `lambda:<id>:concurrency` is registered only when `concurrency` is set.

### API Gateway child resources

API Gateway constructs (`packages/aws/src/api-gateway/`) register these child resources:

| Child ID | Resource |
| :--- | :--- |
| `api:<apiId>` | `aws.apiGateway.Api` |
| `api:<apiId>:stage` | `aws.apiGateway.Stage` |
| `api-authorizer:<apiId>:<authId>` | `aws.apiGateway.RouteAuth` |
| `api-route:<apiId>:<METHOD> <path>` | `aws.apiGateway.Route` |
| `api-integration:<apiId>:<lambdaId>` | `aws.apiGateway.LambdaIntegration` |
| `api-permission:<apiId>:<lambdaId>` | `aws.lambda.LambdaPermission` |

`api:<apiId>` uses `ProtocolType: "HTTP"`, and `api:<apiId>:stage` configures `StageName: "$default"` with `AutoDeploy: true`. `api-integration:<apiId>:<lambdaId>` and `api-permission:<apiId>:<lambdaId>` are added on `lambdaGroup` via `addOnce`.

### SQS child resources

`QueueGroup` (`packages/aws/src/sqs/queue.ts`) registers these child resources:

- **`sqs-queue:<queueId>`** – `aws.sqs.Queue`
- **`sqs-mapping:<queueId>:<lambdaId>`** – `aws.lambda.LambdaEventSourceMapping` (added to the `QueueGroup` by `"~subscribe"`, depending on `lambdaGroup.policy`)

### EventBridge child resources

EventBridge constructs (`packages/aws/src/event-bridge/`) register these child resources:

| Child ID | Resource |
| :--- | :--- |
| `eventbridge-bus:<busId>` | `aws.eventBridge.EventBus` |
| `eventbridge-default-bus` | `aws.eventBridge.DefaultEventBus` |
| `eventbridge-pattern-rule:<ruleId>` | `aws.eventBridge.EventBridgeRule` |
| `eventbridge-pattern-permission:<ruleId>` | `aws.lambda.LambdaPermission` |
| `eventbridge-rule:<scheduleId>` | `aws.eventBridge.EventBridgeRule` |
| `eventbridge-permission:<scheduleId>` | `aws.lambda.LambdaPermission` |

`eventbridge-default-bus` sets `Name: "default"` and is deduplicated per collection. Pattern rules (`rule()` and `eventBridge.bind().defineRule()`) and schedules (`schedule()` and `eventBridge.defineSchedule()`) each add their `LambdaPermission` child onto `lambdaGroup`.

## Lambda internals

### Integration deduplication

When multiple routes on one `ApiGroup` target the same `LambdaGroup`, `RouteGroup` (`packages/aws/src/api-gateway/route.ts`) calls `lambdaGroup.addOnce(...)` for `api-integration:<apiId>:<lambdaId>` and `api-permission:<apiId>:<lambdaId>`. Each `(api, lambda)` pair therefore creates one `LambdaIntegration` and one `LambdaPermission`. The permission's `SourceArn` uses `api.outputRef("ExecuteApiSourceArn")` (`arn:aws:execute-api:<region>:<accountId>:<apiId>/*/*`).

`statementId(id)` (`packages/aws/src/resources/utils/statement-id.ts`) derives `LambdaPermission.StatementId`. IDs matching `/^[0-9A-Za-z_-]{1,100}$/` pass through unchanged. Otherwise, characters outside `[0-9A-Za-z_-]` become `_`, and the string is truncated and suffixed with `-` plus a 12-character SHA-256 hex digest of the full ID.

### Empty policy omission

IAM rejects an inline role policy with an empty `Statement` array as malformed. `LambdaGroup` (`packages/aws/src/lambda/lambda.ts`) exposes `policy` as a lazy getter backed by `addOnce(aws.lambda.LambdaRolePolicy, ...)`, so functions without policy statements omit `LambdaRolePolicy` from the graph. `LambdaRolePolicy` (`packages/aws/src/resources/lambda/lambda-role-policy.ts`) also rejects empty `Statement` arrays before calling `PutRolePolicyCommand`.

On `read`, `LambdaRolePolicy` and `LambdaIamRole` (`packages/aws/src/resources/lambda/lambda-role.ts`) URL-decode RFC 3986-encoded policy documents returned by IAM. `LambdaRolePolicy` normalizes single-object `Statement` values into arrays. `LambdaIamRole` re-serializes `AssumeRolePolicyDocument` compactly to match `JSON.stringify(lambdaTrustPolicy)`.

### Function deployment

- **IAM propagation** – `runLambdaMutation` (`packages/aws/src/resources/utils/lambda-mutation.ts`) catches `InvalidParameterValueException` errors indicating an un-assumable or un-propagated execution role and throws `ResourceOperationPendingError` (`retryAfterMs: 1_000`).
- **Active polling** – `LambdaFunction.read` (`packages/aws/src/resources/lambda/lambda.ts`) polls with `ResourceOperationPendingError` (`retryAfterMs: 1_000`) until `Configuration.State === "Active"` and `Configuration.RevisionId` is present.
- **Archive verification** – `readCode` verifies the SHA-256 base64 digest of the zip file on disk against `CodeSha256` before uploading so resumed deploys detect stale build artifacts.
- **Environment variables** – `encodeEnvironment` enforces `LAMBDA_ENVIRONMENT_MAX_BYTES = 4096`. On update, removed variables are cleared by sending `Environment: { Variables: {} }`.
- **Reserved concurrency** – `LambdaFunctionConcurrency` sets `blocksDeleteOf: [LambdaFunction.type]` so replacements delete the reservation before replacing the function.

## API Gateway internals

### Name lookup

AWS assigns `ApiId`, `AuthorizerId`, and `RouteId` and permits duplicate API names. `Api.find`, `RouteAuth.find`, and `Route.find` (`packages/aws/src/resources/api-gateway/`) paginate `GetApisCommand`, `GetAuthorizersCommand`, and `GetRoutesCommand` via `findOnlyInPages` (`packages/aws/src/resources/utils/paginate.ts`). They match on `Name` or `RouteKey` and fail if multiple matches exist. `RouteAuth.find` and `Route.find` map `NotFoundException` from listing a missing parent API to `ResourceNotFoundError`.

### Conflict handling

`Route.create` and `Stage.create` pass `alreadyExists: (error) => error instanceof sdk.ConflictException` to `awsCreate` so unknown create outcomes recover via `find` or `read`.

### Legacy create token tag

`Api.read` (`packages/aws/src/resources/api-gateway/api.ts`) strips `"notation:create-token"` (`CREATE_TOKEN_TAG`) from `result.Tags` via `withoutCreateTokenTag`. If no other tags remain, it returns `undefined` so older tagged APIs do not plan an immutable `Tags` replacement. `Api.read` also computes `ExecuteApiSourceArn` via `executeApiSourceArn(key.ApiId!)`.

## SQS internals

### Queue deletion cooldown

`Queue.create` (`packages/aws/src/resources/sqs/queue.ts`) checks `getQueueUrl` before calling `CreateQueueCommand`. Otherwise, `CreateQueue` adopts an existing queue with matching name and attributes instead of failing. It maps `sdk.QueueNameExists` to `ResourceAlreadyExistsError` and `sdk.QueueDeletedRecently` to `ResourceOperationPendingError` (`retryAfterMs: 5_000`).

### Attribute resets

Because `SetQueueAttributesCommand` cannot unset attributes, `Queue.update` maps any key present in `patch` with value `undefined` to its SQS default from `ATTRIBUTE_DEFAULTS`:

| Attribute | Default |
| :--- | :--- |
| `VisibilityTimeout` | `"30"` |
| `MessageRetentionPeriod` | `"345600"` |
| `DelaySeconds` | `"0"` |
| `ReceiveMessageWaitTimeSeconds` | `"0"` |
| `MaximumMessageSize` | `"1048576"` |
| `RedrivePolicy` | `""` |
| `RedriveAllowPolicy` | `""` |
| `ContentBasedDeduplication` | `"false"` |
| `DeduplicationScope` | `"queue"` |
| `FifoThroughputLimit` | `"perQueue"` |

`Queue.read` reads missing `RedrivePolicy` and `RedriveAllowPolicy` attributes as `""` so drift detection catches externally removed policies. On `CreateQueue`, `toAttributes` omits `""` values.

### Mapping polling

`LambdaEventSourceMapping` (`packages/aws/src/resources/lambda/lambda-event-source-mapping.ts`) coordinates transitional states and update resets:

- **Mutations** – `runMappingMutation` converts `ResourceInUseException` to `ResourceOperationPendingError` (`retryAfterMs: 1_000`).
- **Polling** – `read` polls with `ResourceOperationPendingError` (`retryAfterMs: 1_000`) while `State` is in `TRANSITIONAL_STATES` (`Creating`, `Enabling`, `Disabling`, `Updating`, `Deleting`). `find` filters out mappings in `"Deleting"` state.
- **Update resets** – Omitted fields reset to defaults: `BatchSize` (`10` for SQS/MQ or `100` for streams), `MaximumBatchingWindowInSeconds: 0`, `Enabled: true`, `FunctionResponseTypes: []`, and `ScalingConfig: {}`.

## EventBridge internals

### Retry policy defaults

When `retry` is configured on a rule, `RuleGroup` (`packages/aws/src/event-bridge/rule-group.ts`) fills unset fields with EventBridge's defaults (`MaximumRetryAttempts: maxAttempts ?? 185`, `MaximumEventAgeInSeconds: maxEventAge ?? 86_400`). This ensures `read` comparisons against `ListTargetsByRule` match whether AWS returns or omits defaults.

### Target failure rollback

`PutTargetsCommand` and `RemoveTargetsCommand` report target-level errors inside `FailedEntryCount` and `FailedEntries` rather than throwing. `EventBridgeRule` (`packages/aws/src/resources/event-bridge/rule.ts`) inspects every response with `assertNoFailedTargets`.

Before creating, `EventBridgeRule` checks `describeRule` because `PutRule` overwrites existing rules. If `PutTargets` throws or reports failed entries, `deleteCreatedRule` deletes the rule before rethrowing. If rollback deletion fails, it throws `ResourceCreationUnknownError` so no targetless rule remains.

On `update`, `EventBridgeRule` lists live targets via `ListTargetsByRuleCommand`. It removes stale target IDs first so target swaps do not breach per-rule target limits, then calls `PutTargetsCommand`. On `delete`, it removes all existing targets before calling `DeleteRuleCommand`. `EventBridgeRule` also declares `blocksDeleteOf: [EventBus.type]`.

### Default event bus

`DefaultEventBus` (`packages/aws/src/resources/event-bridge/event-bus.ts`) calls `DescribeEventBusCommand({ Name: "default" })` in both `create` and `read`. Its `delete` handler is a no-op so rules can reference its ARN without modifying or deleting the account's default bus.

### Compacted pattern diffing

`EventBridgeRule.deriveParams` compacts `config.EventPattern` using `compactJson` (`JSON.stringify(JSON.parse(json))`). `EventBridgeRule.read` applies `compactJson` to the `EventPattern` from `DescribeRuleCommand` so formatting differences never trigger spurious updates.
