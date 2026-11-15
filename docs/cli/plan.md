# notation plan

```sh
notation plan [--config <path>] [--stage <stage>] [--replace <id>[@<hash>]] [--override-loss-protection <id>]
```

| Option                            | Meaning                                                                                                     |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `--config <path>`                 | The config file. Default: the nearest `notation.config.ts`.                                                 |
| `--stage <stage>`                 | The stage. Default: `defaultStage`.                                                                         |
| `--replace <id>[@<hash>]`         | Plan a replace of the resource with this ID. Repeatable. See [Replacing a resource](#replacing-a-resource). |
| `--override-loss-protection <id>` | Plan the replace of a resource that `--replace` names, though its class refuses the replace. Repeatable.    |

Compiles the entry file and shows what a deploy to the stage would change:

```sh
notation plan --stage prod
```

The plan reads remote resources when drift detection applies. It does not perform create,
update, or delete operations.

Each line names the decision, the resource type and the resource ID. A replace also shows its order:

```
+/- replace aws/lambda/LambdaIamRole lambda:orders:role (create, then delete)
-/+ replace aws/lambda/LambdaPermission api-permission:orders-api:orders (delete, then create)
```

A resource whose name deploy generates, such as a function, a role, a queue, a bus, a rule, an API or a Worker, is replaced create-first. Deploy creates the replacement under a new name, updates the dependents to use it, and deletes the old resource at the end of the deploy. Every other resource is replaced delete-first. See [Create-first replacement](../internals/reconciler.md#create-first-replacement).

Until deploy deletes it, the old resource is retired: it is listed in the state record of its replacement. A deploy that stops before its end leaves it there. The plan shows each retired resource as a delete:

```
- delete-retired aws/lambda/LambdaIamRole lambda:orders:role
    the instance that a replace retired at 2026-11-13T09:12:44.120Z, deleted at the end of the deploy
```

When deploy replaces the resource delete-first, it deletes the retired resources with it. The plan then shows them just before the replace, and prints `deleted before the resource is replaced`.

The summary counts it among the deletes.

For resources that depend on each other, the plan prints a line under the resource that deploy creates first, without the contributions that refer to the others:

```
+ create cloudflare/workers/WorkerScript worker:api
    created first without the contributions that refer to worker:reports, the other members of its cycle
```

See [Dependency cycles](../internals/reconciler.md#dependency-cycles).

When deploy replaces a resource delete-first, and the provider can force its delete while others refer to it, the plan names the resources whose references are broken from the delete until deploy updates them:

```
-/+ replace <type> <id> (delete, then create)
    the references from worker:reports are broken until deploy updates them
```

If the deploy fails between the delete and those updates, the references stay broken until a later deploy succeeds. Of the classes in Notation's provider packages, only the Cloudflare Worker's delete can be forced, and a Worker is replaced create-first, so its plan has no such line. See [Deleting a Worker that other Workers bind](../providers/cloudflare/workers.md#deleting-a-worker-that-other-workers-bind).

When an earlier deploy started the create of a resource and did not finish it, state holds a `creating` record for the resource. The plan prints a line under the create:

```
+ create aws/lambda/LambdaIamRole lambda:todos:role
    recovers a create that an earlier deploy did not finish
```

If the earlier create made the resource, deploy takes it over: it reads the resource, and then updates, replaces or keeps it. Otherwise deploy creates the resource. See [Recoverable creates](../internals/reconciler.md#recoverable-creates).

Deploy generates the AWS name of a resource, such as a function or a queue, when it first creates the resource. In the JSON output, the `params` of such a resource show the name as `{ "$unknown": "after-apply" }` until the resource exists. The same holds for a resource that deploy replaces, because the replacement gets a new name. The plan of a replace does not list the name among the fields that change. See [Generated names](../manual/project-config.md#generated-names).

## Replacing a resource

`--replace` plans the replace that [`notation deploy --replace`](./deploy.md#replacing-a-resource) makes. The instance hash is optional, because plan changes nothing. When you give it, plan checks it as deploy does.

```sh
notation plan --stage prod --replace lambda:orders:role
```

The plan shows the replace, and every change that follows from it:

```
+/- replace aws/lambda/LambdaIamRole lambda:orders:role (create, then delete)
    replaced by --replace
~ update aws/lambda/LambdaFunction lambda:orders

Plan: 0 to create, 1 to update, 1 to replace, 0 to recreate, 0 to delete, 9 unchanged.

To deploy this plan:
  notation deploy --stage prod --replace lambda:orders:role@3c1f9a02
```

The last line is the deploy command, with the instance hash of each resource that `--replace` names. Copy it to deploy the plan. When a changed param also replaces the resource, the plan shows one replace with both reasons.

## JSON output

`--json` writes the complete plan to stdout. Build output and diagnostics move to stderr.

```sh
notation plan --stage prod --json > plan.json
```

Each node has `id`, `type`, `decision`, `params` and `dependsOn`. A node with the decision `replace` or `drift-replace` has `replaceOrder`, `"create-first"` or `"delete-first"`. A retired resource is a node with the decision `delete-retired`. It has the ID of the resource that replaced it, `retiredIndex`, its position in the list of retired instances of that resource, its own `params` and `dependsOn`, and `retiredAt`, the time when the replace started. The ID and `retiredIndex` together name the instance. A node of a resource in code that has a state record has `instanceHash`, the hash that `--replace` takes. A replace that `--replace` asked for has `{ "requested": true, "known": true }` in its `replaceFields`.
