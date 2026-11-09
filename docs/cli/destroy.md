# notation destroy

```sh
notation destroy [--config <path>] [--stage <stage>]
```

| Option            | Meaning                                                     |
| ----------------- | ----------------------------------------------------------- |
| `--config <path>` | The config file. Default: the nearest `notation.config.ts`. |
| `--stage <stage>` | The stage. Default: `defaultStage`.                         |

Compiles the entry file and destroys the resources of the stage. The command removes the resources in reverse dependency order, and then removes the orphans in state whose resource type is registered. A type is registered when a resource in the graph has it, or when the provider package named in its state record is installed and exports its class. A record written before provider packages were recorded names none, and its class is looked up in `@notation/aws.iac` and `@notation/std.iac`.

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
