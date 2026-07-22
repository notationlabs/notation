# notation deploy

```sh
notation deploy <entryPoint>
```

Compiles and durably deploys the stack through the resident YieldStar 0.5.0 Node runtime.

```sh
notation deploy infra/api.ts
```

## Event stream

`--json` writes versioned reconciler events to stdout as newline-delimited JSON. Build output, the execution ID, and diagnostics move to stderr.

```sh
notation deploy infra/api.ts --json > deploy.ndjson
```

## Durable execution

The command prints its YieldStar execution ID before starting provider work. If the process crashes, resume the same durable heap with that ID:

```sh
notation deploy infra/api.ts --execution-id <id>
```

Do not reuse a completed execution ID for a new deploy or for destroy.

Retryable provider conditions and consistency reads suspend on durable SQLite timers. The CLI stays resident until the scheduler wakes the execution and the workflow completes; completed provider calls are replayed from the heap rather than repeated.

## What happens

1. **Compile** – esbuild compiles infrastructure and runtime modules to `dist/`.

2. **Build resource graph** – the worker imports the compiled output and collects declared resources.

3. **Reconcile** – Notation compares desired resources with YieldStar stores, then creates, updates, recreates, or leaves each resource unchanged.

4. **Order dependencies** – dependency levels run in topological order.

5. **Detect drift** – unchanged resources are read from the provider and repaired when their remote state differs.

6. **Delete orphans** – persisted resources absent from the graph are deleted when their resource type is registered.

State, step results, timers, task coordination, and resource stores are persisted to `.notation/workflows.db`. Set `NOTATION_STATE_PATH` to choose another SQLite database path.
