# notation deploy

```sh
notation deploy [--config <path>] [--stage <stage>]
```

| Option            | Meaning                                                     |
| ----------------- | ----------------------------------------------------------- |
| `--config <path>` | The config file. Default: the nearest `notation.config.ts`. |
| `--stage <stage>` | The stage. Default: `defaultStage`.                         |

Compiles the entry file and deploys it to the stage. Each stage has its own state, under the key `<app>:<stage>`. See [Project Config](../manual/project-config.md).

```sh
notation deploy --stage prod
```

## Event stream

`--json` writes versioned reconciler events to stdout as newline-delimited JSON. Build output, the execution ID, and diagnostics move to stderr.

```sh
notation deploy --stage prod --json > deploy.ndjson
```

## Durable execution

The command prints its execution ID before it starts provider work, and the command that resumes the execution:

```sh
Execution ID 0195f0c2-7d1e-7b4a-9c3e-2f6a8b1d4e70
To resume after a crash, run notation deploy --execution-id 0195f0c2-7d1e-7b4a-9c3e-2f6a8b1d4e70
```

When a deploy starts, Notation saves the state key `<app>:<stage>` with the execution. When you resume, the command reads the stage from the saved key, so you don't pass `--stage`. The command still needs the config, because the config names the entry file. If you deployed with `--config`, the printed command includes it.

The command fails if the config's `app` is not the saved app, or if you pass a `--stage` that is not the saved stage:

```sh
Execution <id> is for stage prod, not dev. Leave out --stage, or pass --stage prod
```

Do not reuse a completed execution ID for a new deploy or for destroy.

Retryable provider conditions and consistency reads suspend on durable SQLite timers. The CLI stays resident until the scheduler wakes the execution and the workflow completes. Provider results are replayed after their heap checkpoint, but a crash after the provider accepts a create or update and before that checkpoint repeats the call, so provider mutations must be idempotent. Reconciler event consumers must tolerate the equivalent duplicate-delivery window.

## What happens

1. **Compile** – Rolldown compiles infrastructure and runtime modules to `dist/`. See [notation compile](./compile.md).

2. **Build resource graph** – the CLI imports the compiled output in-process and collects declared resources.

3. **Order dependencies** – dependency levels run in topological order.

4. **Reconcile** – Notation compares desired resources with `@notation/durable` stores, then creates, updates, recreates, or leaves each resource unchanged.

5. **Detect drift** – unchanged resources are read from the provider and repaired when their remote state differs.

6. **Delete orphans** – persisted resources absent from the graph are deleted when their resource type is registered. A type is registered when a resource in the graph has it, or when the provider package named in its state record is installed and exports its class.

State, step results, timers, queued tasks, and resource stores are persisted to `.notation/workflows.db`. Set `NOTATION_DATABASE_PATH` to choose another SQLite database path.
