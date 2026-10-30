# @notation/aws.iac

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
- Updated dependencies [7d01d51]
  - @notation/resource@0.16.0
  - @notation/core@0.16.0
  - @notation/utils@0.16.0
  - @notation/std.iac@0.16.0

## 0.15.0

### Minor Changes

- 83f0de1: `ResourceGroup` now takes its config as its own argument: `super(type, id, config)`. Previously, every key except `id` and `dependencies` was collected into `group.config`, so a config with its own `id` or `dependencies` key lost it to the group.

  `ResourceGroup` and `AwsResourceGroup` take an optional type parameter for the config, so `group.config` is typed. `LambdaGroup`, `ApiGroup` and `ScheduleGroup` use it, and `LambdaGroup.config` is now the `LambdaConfig` itself rather than `{ config: LambdaConfig }`.

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

### Patch Changes

- 18c2b4c: Schema items no longer accept `defaultValue` or `propertyType: "derived"`. Nothing read either at runtime, so a `defaultValue` never filled in a missing param. Set the value in params, or compute it with `deriveParams`.
- 91806d0: Creating, updating or deleting an EventBridge rule now fails when AWS rejects any of its target changes, listing each failed target's id, error code and message. Previously PutTargets and RemoveTargets partial failures were ignored and the deploy recorded success.
- 41f2a02: Updating an EventBridge rule now removes targets that are no longer in config. Previously a removed target stayed attached to the rule in AWS and kept receiving events.
- f150ec6: Stop drift detection from replacing unchanged Lambda IAM roles on every deploy. The role read now decodes the URL-encoded trust policy and returns the permissions boundary as its ARN, and the Lambda function read drops computed fields from `VpcConfig` and `SnapStart`, so reads compare cleanly with configured params.
- 6943418: `diffParams` now puts each changed param in `patch` whole, rather than as a nested diff. Changing one Lambda environment variable no longer drops the others, removing all of them now clears them, and an EventBridge rule update no longer sends a rule with no name or targets keyed by index. `@notation/core` drops its unused `deep-object-diff` dependency.
- Updated dependencies [bddd9f8]
- Updated dependencies [18c2b4c]
- Updated dependencies [83f0de1]
- Updated dependencies [16a0209]
- Updated dependencies [425f8ba]
- Updated dependencies [b290eb1]
- Updated dependencies [4fe4451]
- Updated dependencies [7a90e6b]
- Updated dependencies [6508511]
- Updated dependencies [6943418]
  - @notation/resource@0.15.0
  - @notation/core@0.15.0
  - @notation/std.iac@0.15.0

## 0.14.0

### Patch Changes

- Updated dependencies [9afdb3c]
  - @notation/resource@0.14.0
  - @notation/core@0.14.0
  - @notation/std.iac@0.14.0

## 0.13.0

### Minor Changes

- b7119a8: Add durable Yieldstar 0.5.0 deploy and destroy workflows, a resident Node SQLite runtime for CLI execution, versioned event streams, backend-neutral dashboard state, and compiled infrastructure graphs.
- f7e9186: A resource `read` now returns the remote object or throws the tagged `ResourceNotFoundError`. Operations that have started but not settled throw `ResourceOperationPendingError` with their retry delay and optional callback context. The reconciler follows those explicit instructions instead of guessing retry behaviour from provider errors or call-site context.

### Patch Changes

- Updated dependencies [b7119a8]
- Updated dependencies [f7e9186]
  - @notation/core@0.13.0
  - @notation/resource@0.13.0
  - @notation/std.iac@0.13.0

## 0.12.0

### Patch Changes

- Updated dependencies
  - @notation/core@0.12.0
  - @notation/std.iac@0.12.0
  - @notation/resource@0.12.0

## 0.11.1

### Patch Changes

- Hide large buffers from state file
- Updated dependencies
  - @notation/core@0.11.1
  - @notation/std.iac@0.11.1

## 0.11.0

### Minor Changes

- 5dcb935: Support alternative runtimes

### Patch Changes

- @notation/core@0.11.0
- @notation/std.iac@0.11.0

## 0.10.0

### Minor Changes

- Fix package versions

### Patch Changes

- Updated dependencies
  - @notation/core@0.10.0
  - @notation/std.iac@0.10.0

## 0.6.1

### Patch Changes

- Updated dependencies
  - @notation/core@0.6.1
  - @notation/std.iac@0.6.1

## 0.6.0

### Minor Changes

- Support externally managed lambda modules

### Patch Changes

- Updated dependencies
  - @notation/std.iac@0.6.0

## 0.5.0

### Minor Changes

- 2a6fc59: Add optional JWT authorizer config to route resource

### Patch Changes

- Updated dependencies [2a6fc59]
  - @notation/std.iac@0.5.0
  - @notation/core@0.6.0

## 0.4.3

### Patch Changes

- Fix updating std.zip resource
- Updated dependencies
  - @notation/core@0.5.1
  - @notation/std.iac@0.4.3

## 0.4.2

### Patch Changes

- Updated dependencies [5debdd1]
  - @notation/core@0.5.0
  - @notation/std.iac@0.4.2

## 0.4.1

### Patch Changes

- Removed dev artifacts from dist
- Updated dependencies
  - @notation/core@0.4.1
  - @notation/std.iac@0.4.1

## 0.4.0

### Minor Changes

- Stateful deployments

### Patch Changes

- Updated dependencies
  - @notation/core@0.4.0
  - @notation/std.iac@0.4.0

## 0.3.1

### Patch Changes

- Updated dependencies [b75f89b]
  - @notation/core@0.3.1
  - @notation/std.iac@0.3.1

## 0.3.0

### Minor Changes

- Prepare for release

### Patch Changes

- Updated dependencies
  - @notation/core@0.3.0
  - @notation/std.iac@0.3.0
