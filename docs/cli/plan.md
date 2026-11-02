# notation plan

```sh
notation plan [--config <path>] [--stage <stage>]
```

| Argument          | Meaning                                                            |
| ----------------- | ------------------------------------------------------------------ |
| `--config <path>` | The config file. Defaults to the nearest `notation.config.ts`.     |
| `--stage <stage>` | The stage. Defaults to `defaultStage`, and is required without it. |

Compiles the entry and reports the changes a deploy to the stage would make:

```sh
notation plan --stage prod
```

The plan reads remote resources when drift detection applies. It does not perform create,
update, or delete operations.

## JSON output

`--json` writes the complete plan to stdout. Build output and diagnostics move to stderr.

```sh
notation plan --stage prod --json > plan.json
```
