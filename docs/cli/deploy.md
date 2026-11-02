# notation deploy

```sh
notation deploy [--config <path>] [--stage <stage>]
```

| Argument          | Meaning                                                            |
| ----------------- | ------------------------------------------------------------------ |
| `--config <path>` | The config file. Defaults to the nearest `notation.config.ts`.     |
| `--stage <stage>` | The stage. Defaults to `defaultStage`, and is required without it. |

Compiles the entry file and runs a durable deploy of it to the stage. Notation keys the state of the deployment by `<app>:<stage>`, so each stage of an app has its own state. See [Project Config](../manual/project-config.md).

```sh
notation deploy --stage prod
```

## Event stream

`--json` writes versioned reconciler events to stdout as newline-delimited JSON. Build output, the execution ID, and diagnostics move to stderr.

```sh
notation deploy --stage prod --json > deploy.ndjson
```

## Durable execution

The command prints its execution ID before starting provider work. If the process crashes, resume the same execution with that ID:

```sh
notation deploy --stage prod --execution-id <id>
```

Pass the same config and stage as the crashed command. Notation rejects an execution ID that belongs to another deployment.

Do not reuse a completed execution ID for a new deploy or for destroy.

Retryable provider conditions and consistency reads suspend on durable SQLite timers. The CLI stays resident until the scheduler wakes the execution and the workflow completes. Provider results are replayed after their heap checkpoint, but a crash after the provider accepts a create or update and before that checkpoint repeats the call, so provider mutations must be idempotent. Reconciler event consumers must tolerate the equivalent duplicate-delivery window.

## What happens

1. **Compile** – esbuild compiles infrastructure and runtime modules to `dist/`.

2. **Build resource graph** – the CLI imports the compiled output in-process and collects declared resources.

3. **Order dependencies** – dependency levels run in topological order.

4. **Reconcile** – Notation compares desired resources with Yieldstar stores, then creates, updates, recreates, or leaves each resource unchanged.

5. **Detect drift** – unchanged resources are read from the provider and repaired when their remote state differs.

6. **Delete orphans** – persisted resources absent from the graph are deleted when their resource type is registered.

State, step results, timers, queued tasks, and resource stores are persisted to `.notation/workflows.db`. Set `NOTATION_DATABASE_PATH` to choose another SQLite database path.
