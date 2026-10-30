# notation plan

```sh
notation plan <entry> [--stage <stage>]
```

| Argument          | Meaning                                                            |
| ----------------- | ------------------------------------------------------------------ |
| `<entry>`         | An entry name from `notation.config.ts`, such as `api`.            |
| `--stage <stage>` | The stage. Defaults to `defaultStage`, and is required without it. |

Compiles the entry and reports the changes a deploy to the stage would make:

```sh
notation plan api --stage prod
```

The plan reads remote resources when drift detection applies. It does not perform create,
update, or delete operations.

## JSON output

`--json` writes the complete plan to stdout. Build output and diagnostics move to stderr.

```sh
notation plan api --stage prod --json > plan.json
```
