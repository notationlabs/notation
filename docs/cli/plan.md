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

For resources that depend on each other, the plan prints a line under the resource that deploy creates first, without the contributions that refer to the others:

```
+ create cloudflare/workers/WorkerScript worker:api
    created first without the contributions that refer to worker:reports, the other members of its cycle
```

See [Dependency cycles](../internals/reconciler.md#dependency-cycles).

When deploy replaces a resource that others refer to, and the provider can force its delete, the plan names the resources whose references are broken from the delete until deploy updates them:

```
-/+ replace cloudflare/workers/WorkerScript worker:api
    ScriptName forces replacement
    the references from worker:reports are broken until deploy updates them
```

If the deploy fails between the delete and those updates, the references stay broken until a later deploy succeeds. See [Deleting a Worker that other Workers bind](../providers/cloudflare/workers.md#deleting-a-worker-that-other-workers-bind).

## JSON output

`--json` writes the complete plan to stdout. Build output and diagnostics move to stderr.

```sh
notation plan --stage prod --json > plan.json
```
