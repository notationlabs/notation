# notation dashboard

```sh
notation dashboard <entry> [--stage <stage>]
```

| Argument          | Meaning                                                            |
| ----------------- | ------------------------------------------------------------------ |
| `<entry>`         | An entry name from `notation.config.ts`, such as `api`.            |
| `--stage <stage>` | The stage. Defaults to `defaultStage`, and is required without it. |

Starts a local web dashboard for observing the resource state of the entry's deployment to the stage.

```sh
notation dashboard api --stage dev
```

The dashboard reads `.notation/workflows.db`, the same database used by deploy, destroy, and plan. Set `NOTATION_DATABASE_PATH` to choose another SQLite database path.
