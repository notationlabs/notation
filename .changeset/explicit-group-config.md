---
"@notation/aws": minor
"@notation/aws.iac": minor
"@notation/resource": minor
---

`ResourceGroup` now takes its config under an explicit `config` key, the same way `Resource` does: `super(type, { config })`. Previously, every key except `id` and `dependencies` was collected into `group.config`, so a config with its own `id` or `dependencies` key lost it to the group.

`ResourceGroup` and `AwsResourceGroup` take an optional type parameter for the config, so `group.config` is typed. `LambdaGroup`, `ApiGroup` and `ScheduleGroup` use it, and `LambdaGroup.config` is now the `LambdaConfig` itself rather than `{ config: LambdaConfig }`.
