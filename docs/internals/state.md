# State

Notation CLI deploy, destroy, plan, and dashboard use `@notation/durable` stores in `.notation/workflows.db`. Override the database path with `NOTATION_DATABASE_PATH`.

Each live resource is a `notation/resource-state` store scoped by deployment and resource ID. A missing store means the resource is absent.

```ts
const state = new DurableStateBackend(storeClient, "my-app:prod");
```

The CLI sets the deployment ID to `<app>:<stage>`. See [State key](../manual/project-config.md#state-key).

The runtime assigns a UUIDv7 `instanceId` when a store is created and increments its version on update. Conditional workflow updates and deletes compare both values, preventing a stale snapshot from modifying a deleted and recreated resource. The store version is exposed unchanged as `StateNode.version`.

Each record holds the resource's `id`, `type`, `provider`, `group`, `config`, `params`, `output` and `dependsOn`. `provider` is the package or package subpath that exports the resource's class, such as `@notation/aws/resources`, so deploy and destroy can load the class of a record whose type is no longer in the graph. `params` hold each physical name that deploy generated, and the record is the only place that holds it; see [Generated names](./reconciler.md#generated-names). `dependsOn` lists the IDs of the resources it depends on, so the reconciler can order the deletes of orphans from state alone. A record written before edges were recorded has no `dependsOn`. See [Dependency edges](./reconciler.md#dependency-edges).

`lastOperation` is `create`, `update` or `creating`. Deploy writes a `creating` record before it calls a resource's `create`, and replaces it with a `create` record when the create is done. A `creating` record says that a deploy tried to create the resource, and may or may not have made it. Its `output` holds the key fields that params supply. Its `params` hold each physical name that deploy generated, so the next deploy uses the same name. See [Recoverable creates](./reconciler.md#recoverable-creates).

A record can have a `retired` list: the instances of the resource that a create-first replace left, oldest first, each waiting for deploy to delete it. Each entry holds the `config`, `params`, `output` and `dependsOn` of the old resource, and `retiredAt`, the time when the replace started. The instance has the type and provider of its record. A record with no retired instances has no `retired` field. Every write to the record keeps the list, and a record that lists retired instances is not removed. See [Create-first replacement](./reconciler.md#create-first-replacement).

A create-first replace writes the replacement's records to the store of the old resource, so the store keeps its `instanceId`. A delete-first replace removes the store, and its create makes a new one with a new `instanceId`. So the `instanceId` does not show whether a resource was replaced.

`DurableStateBackend` is read-only: state writes happen inside the workflow, through the store handle, so each write is stamped with the step that made it and is not repeated on replay.

The workflow serializes deploy and destroy through one `notation/deployment-hold` store per deployment.
