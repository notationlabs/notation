# notation destroy

```sh
notation destroy <entryPoint>
```

Compiles the application and runs a durable destroy. Resources are removed in reverse dependency order, then registered persisted orphans are removed.

```sh
notation destroy infra/api.ts
```

`--json` writes versioned reconciler events to stdout as newline-delimited JSON:

```sh
notation destroy infra/api.ts --json > destroy.ndjson
```

The command prints its execution ID. Resume a crashed destroy with the same ID so checkpointed work can be replayed:

```sh
notation destroy infra/api.ts --execution-id <id>
```

Retryable deletes suspend on durable SQLite timers. Resource state is removed only after the provider delete succeeds or reports that the resource is already absent.

The crash-window contract described under [notation deploy](./deploy.md#durable-execution) applies to deletes as well.
