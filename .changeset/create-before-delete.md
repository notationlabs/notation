---
"@notation/reconciler": minor
"@notation/state": minor
"@notation/resource": patch
"@notation/cli": patch
"@notation/dashboard": patch
---

Deploy now creates the replacement of a resource with a generated name before it deletes the resource (RFC 0019). The AWS Lambda function, IAM role, SQS queue, EventBridge rule and bus, API Gateway API and the Cloudflare Worker have generated names.

- A replace creates first when the resource's class has a `physicalName` param. Deploy writes the `creating` record of the replacement and adds the old resource to the record's list of retired instances in the same write. It then creates the replacement, and updates or replaces each dependent with the outputs of the replacement when it reaches it. At the end of the deploy, it deletes each retired instance.
- Every other replace still deletes first. This includes a Lambda permission and an event source mapping, whose key comes from config or from their parents.
- A dependent that blocks the delete of a resource that is replaced create-first is no longer deleted first. `blocksDeleteOf` is now used only by a replace that deletes first. For example, when a bus is replaced, each rule on it is replaced create-first too, and the old rules are deleted before the old bus.
- When the create of the replacement fails, deploy writes back the record of the old resource, and nothing is deleted. When the create has an unknown outcome, the old resource stays retired, and the next deploy resolves the create.
- A deploy that stops after the create leaves the old resource retired. The next deploy deletes it at its end, after it has updated the dependents that the stopped deploy did not reach.
- The sweep at the end of a deploy deletes the orphans and the retired instances together, in reverse order of their edges. A record's retired instances are deleted just before the record. A dependent that is no longer in code is deleted before the retired instance that it uses.
- When the provider refuses to delete a retired instance, the deploy fails and names the resources in code that depend on the resource. The instance stays retired, and the next deploy tries to delete it again.
- `notation destroy` deletes the retired instances first.
- `@notation/state`: a state record gains an optional `retired` list. Each entry holds the old resource's `config`, `params`, `output` and `dependsOn`, and `retiredAt`. Every write to the record keeps the list, and a record that lists retired instances is not removed.
- `notation plan` prints the order after each replace: `+/- replace ... (create, then delete)` for a create-first replace, and `-/+ replace ... (delete, then create)` for a delete-first one. It prints each retired instance that waits in state as `- delete-retired`, with the time when it was retired, and counts it among the deletes in the summary.
- `@notation/dashboard`: the resource list marks a resource that has retired instances, and the resource view lists them with the time when each was retired.
- `notation plan --json` adds `replaceOrder` (`"create-first"` or `"delete-first"`) to each `replace` and `drift-replace` node. A retired instance that waits in state is planned as a node with the decision `delete-retired`, the ID of its resource, its own params and edges, and `retiredAt`. The deploy decision event carries `replaceOrder` too, and the delete of a retired instance has the reason `retired`.
- `@notation/resource`: for the delete of a retired instance, `ResourceDeletion.dependents` leaves out the dependents in code, and lists the retired instances of other resources that depend on it.
- Two instances of a resource exist for part of a deploy, so a replace can fail on an account quota that it passed before. A queue that is replaced still loses its messages, at the end of the deploy instead of at the start.
