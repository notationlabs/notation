# notation plan

```sh
notation plan [--config <path>] [--stage <stage>]
```

| Option            | Meaning                                                     |
| ----------------- | ----------------------------------------------------------- |
| `--config <path>` | The config file. Default: the nearest `notation.config.ts`. |
| `--stage <stage>` | The stage. Default: `defaultStage`.                         |

Compiles the entry file and shows what a deploy to the stage would change:

```sh
notation plan --stage prod
```

The plan reads remote resources when drift detection applies. It does not perform create,
update, or delete operations.

For resources that depend on each other, the plan prints a line under the resource that deploy creates first, without the contributions that refer to the others, and under a resource that is replaced while other resources in its cycle refer to it:

```
+ create cloudflare/workers/WorkerScript worker:api
    created first without the contributions that refer to worker:reports, the other members of its cycle
-/+ replace cloudflare/workers/WorkerScript worker:reports
    ScriptName forces replacement
    worker:api is reverted to its placeholder first, and worker:reports is unavailable until the cycle settles
```

See [Dependency cycles](../internals/reconciler.md#dependency-cycles).

## JSON output

`--json` writes the complete plan to stdout. Build output and diagnostics move to stderr.

```sh
notation plan --stage prod --json > plan.json
```
