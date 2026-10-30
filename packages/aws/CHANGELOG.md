# @notation/aws

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
