# @notation/resource

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
