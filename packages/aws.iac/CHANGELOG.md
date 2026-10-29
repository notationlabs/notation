# @notation/aws.iac

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
