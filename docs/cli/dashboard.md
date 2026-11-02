# notation dashboard

```sh
notation dashboard [--config <path>] [--stage <stage>]
```

| Argument          | Meaning                                                            |
| ----------------- | ------------------------------------------------------------------ |
| `--config <path>` | The config file. Defaults to the nearest `notation.config.ts`.     |
| `--stage <stage>` | The stage. Defaults to `defaultStage`, and is required without it. |

Starts a local web dashboard for observing the resource state of the entry's deployment to the stage. The entry must be named in `notation.config.ts`, but its file does not have to exist.

```sh
notation dashboard --stage dev
```

The dashboard reads `.notation/workflows.db`, the same database used by deploy, destroy, and plan. Set `NOTATION_DATABASE_PATH` to choose another SQLite database path.
