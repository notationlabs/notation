# @notation/dashboard

## 0.20.0

### Patch Changes

- @notation/state@0.20.0

## 0.19.0

### Patch Changes

- 3628aa5: Deploy now creates the replacement of a resource with a generated name before it deletes the resource (RFC 0019). The AWS Lambda function, IAM role, SQS queue, EventBridge rule and bus, API Gateway API and the Cloudflare Worker have generated names.

  - A replace creates first when the resource's class has a `physicalName` param. Deploy writes the `creating` record of the replacement and adds the old resource to the record's list of retired instances in the same write. It then creates the replacement, and updates or replaces each dependent with the outputs of the replacement when it reaches it. At the end of the deploy, it deletes each retired instance.
  - Every other replace still deletes first. This includes a Lambda permission and an event source mapping, whose key comes from config or from their parents.
  - A dependent that blocks the delete of a resource that is replaced create-first is no longer deleted first. `blocksDeleteOf` is now used only by a replace that deletes first. For example, when a bus is replaced, each rule on it is replaced create-first too, and the old rules are deleted before the old bus.
  - When the create of the replacement fails, deploy writes back the record of the old resource, and nothing is deleted. When the create has an unknown outcome, the old resource stays retired, and the next deploy resolves the create.
  - A deploy that stops after the create leaves the old resource retired. The next deploy deletes it at its end, after it has updated the dependents that the stopped deploy did not reach.
  - The sweep at the end of a deploy deletes the orphans and the retired instances together, in reverse order of their edges. A record's retired instances are deleted just before the record. A dependent that is no longer in code is deleted before the retired instance that it uses.
  - When the provider refuses to delete a retired instance, the deploy fails and names the resources in code that depend on the resource. The instance stays retired, and the next deploy tries to delete it again. Destroy fails in the same way.
  - `notation destroy` deletes each record after the records that depend on it, by the edges in code, the edges in state, and the edges of the retired instances. It deletes a record's retired instances just before the record. So a dependent that a stopped deploy did not reach is deleted before the retired instance that it uses.
  - A delete-first replace, and the delete of a dependent that blocks it, delete the record's retired instances when deploy reaches the record. `notation plan` shows them just before the replace. A record whose retired instance depends on a resource that is replaced delete-first counts as a dependent that blocks the delete, when its type lists the resource's type in `blocksDeleteOf`.
  - `@notation/state`: a state record gains an optional `retired` list. Each entry holds the old resource's `config`, `params`, `output` and `dependsOn`, and `retiredAt`. Every write to the record keeps the list, and a record that lists retired instances is not removed.
  - An older version of the CLI does not keep the retired list. When it runs against state that this version wrote, a write that it makes to the record, such as a create or a delete-first replace, drops the list. The old resource then stays in the account with no record.
  - `notation plan` prints the order after each replace: `+/- replace ... (create, then delete)` for a create-first replace, and `-/+ replace ... (delete, then create)` for a delete-first one. It prints each retired instance that waits in state as `- delete-retired`, in the order of the sweep, with the time when it was retired, and counts it among the deletes in the summary.
  - `@notation/dashboard`: the resource list marks a resource that has retired instances, and the resource view lists them with the time when each was retired.
  - `notation plan --json` adds `replaceOrder` (`"create-first"` or `"delete-first"`) to each `replace` and `drift-replace` node. A retired instance that deploy deletes is planned as a node with the decision `delete-retired`, the ID of its resource, `retiredIndex`, its position in the resource's list of retired instances, its own params and edges, and `retiredAt`. So the plan can hold several nodes with the same `id`. The `id` and `retiredIndex` together name a retired instance. The deploy decision event carries `replaceOrder` too, and the delete of a retired instance has the reason `retired`.
  - `@notation/resource`: `ResourceDeletion.dependents` lists the retired instances of other resources that depend on the deleted resource. For the delete of a retired instance, it leaves out the dependents in code.
  - Two instances of a resource exist for part of a deploy, so a replace can fail on an account quota that it passed before. A queue that is replaced still loses its messages, at the end of the deploy instead of at the start.

- Updated dependencies [3628aa5]
- Updated dependencies [19036ae]
  - @notation/state@0.19.0

## 0.18.0

### Patch Changes

- @notation/state@0.18.0

## 0.17.0

### Patch Changes

- ae3d823: The packages are built with tsdown instead of tsup. The entry points and their types are at the same paths. Shared code sits in chunks with different names, and imports of Node built-ins keep their `node:` prefix. The `@notation/aws` entry points now share chunks instead of each bundling its own copy, so they share module state.
- Updated dependencies [ae3d823]
- Updated dependencies [e4f4157]
  - @notation/state@0.17.0

## 0.16.0

### Patch Changes

- Updated dependencies [35196ff]
- Updated dependencies [7d01d51]
  - @notation/state@0.16.0

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
