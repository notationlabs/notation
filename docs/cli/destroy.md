# notation destroy

```sh
notation destroy <entryPoint>
```

Compiles the application and runs durable destroy through the resident Yieldstar 0.5.0 Node runtime. Resources are removed in reverse dependency order, then registered persisted orphans are removed.

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

The provider acknowledgement and heap checkpoint are not atomic. A crash between them repeats the delete, so provider delete operations must be idempotent and event consumers must tolerate duplicate delivery.
