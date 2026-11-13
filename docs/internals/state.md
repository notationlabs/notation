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

`DurableStateBackend` is read-only: state writes happen inside the workflow, through the store handle, so each write is stamped with the step that made it and is not repeated on replay.

The workflow serializes deploy and destroy through one `notation/deployment-hold` store per deployment.
