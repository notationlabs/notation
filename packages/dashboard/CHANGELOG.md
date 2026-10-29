# @notation/dashboard

## 0.15.0

### Minor Changes

- 7a90e6b: Resource groups now have stable string IDs. Previously, a group's ID was its position in the graph, so adding a group shifted the IDs of every group declared after it, and groups built outside a graph all had the ID `-1`.

  - `ResourceGroup` requires an `id`, a string that must be unique among groups of the same type. Declaring two groups with the same type and ID in one graph throws.
  - `LambdaGroup` uses the lambda's `id`, `ApiGroup` the API's `name`, `RouteGroup` `<api id>-<method>-<path>` and `ScheduleGroup` the schedule's `name`.
  - `ResourceGroup`'s `type`, `id`, `config` and `resources` are read-only.
  - Resources record their group as `resource.group`, a `{ type, id }` pair, or `null` if they are in no group. This replaces `groupId` and `groupType`, in memory and in persisted state. `@notation/resource` and `@notation/core` export the pair's type as `ResourceGroupRef`.
  - The dashboard labels groups by type and ID, such as `Lambda get-todos`, instead of by position.

  State written by earlier versions still loads, deploys and destroys. Its records keep `groupId` and `groupType` until their resource is next created or updated, and the dashboard lists them as ungrouped until then.

### Patch Changes

- @notation/state@0.15.0

## 0.14.0

### Patch Changes

- @notation/state@0.14.0

## 0.13.0

### Patch Changes

- Updated dependencies [b7119a8]
  - @notation/state@0.13.0

## 0.12.0

## 0.11.1

### Patch Changes

- Hide large buffers from state file

## 0.11.0

## 0.10.0

### Minor Changes

- Fix package versions

## 0.3.0

### Minor Changes

- Fix dashboard

## 0.2.0

### Minor Changes

- 5debdd1: Show deployed resource state in dashboard

## 0.1.0

### Minor Changes

- Release dashboard
