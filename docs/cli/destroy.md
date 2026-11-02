# notation destroy

```sh
notation destroy [--config <path>] [--stage <stage>]
```

| Option            | Meaning                                                     |
| ----------------- | ----------------------------------------------------------- |
| `--config <path>` | The config file. Default: the nearest `notation.config.ts`. |
| `--stage <stage>` | The stage. Default: `defaultStage`.                         |

Compiles the entry file and destroys the deployment to the stage. Resources are removed in reverse dependency order, then registered persisted orphans are removed.

```sh
notation destroy --stage prod
```

`--json` writes versioned reconciler events to stdout as newline-delimited JSON:

```sh
notation destroy --stage prod --json > destroy.ndjson
```

The command prints its execution ID. Resume a crashed destroy with the same ID so checkpointed work can be replayed:

```sh
notation destroy --stage prod --execution-id <id>
```

Retryable deletes suspend on durable SQLite timers. Resource state is removed only after the provider delete succeeds or reports that the resource is already absent.

The crash-window contract described under [notation deploy](./deploy.md#durable-execution) applies to deletes as well.
