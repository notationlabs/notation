# notation destroy

```sh
notation destroy [--config <path>] [--stage <stage>]
```

| Option            | Meaning                                                     |
| ----------------- | ----------------------------------------------------------- |
| `--config <path>` | The config file. Default: the nearest `notation.config.ts`. |
| `--stage <stage>` | The stage. Default: `defaultStage`.                         |

Compiles the entry file and destroys the resources of the stage. The command removes the orphans in state whose resource type is registered, and then removes the resources in reverse dependency order. A type is registered when a resource in the graph has it, or when the provider package named in its state record is installed and exports its class. The command removes the retired instances that a create-first replace left in a state record just before the record, after the resources in code that depend on it. A retired instance that depends on a resource is removed before that resource. See [Create-first replacement](../internals/reconciler.md#create-first-replacement).

```sh
notation destroy --stage prod
```

`--json` writes versioned reconciler events to stdout as newline-delimited JSON:

```sh
notation destroy --stage prod --json > destroy.ndjson
```

The command prints its execution ID. Resume a crashed destroy with the same ID, so that Notation replays the checkpointed work:

```sh
notation destroy --execution-id <id>
```

The stage comes from the execution, as it does for a resumed deploy. See [notation deploy](./deploy.md#durable-execution).

Retryable deletes suspend on durable SQLite timers. Resource state is removed only after the provider delete succeeds or reports that the resource is already absent.

The crash-window contract described under [notation deploy](./deploy.md#durable-execution) applies to deletes as well.
