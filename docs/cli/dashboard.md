# notation dashboard

```sh
notation dashboard [--config <path>] [--stage <stage>]
```

| Option            | Meaning                                                     |
| ----------------- | ----------------------------------------------------------- |
| `--config <path>` | The config file. Default: the nearest `notation.config.ts`. |
| `--stage <stage>` | The stage. Default: `defaultStage`.                         |

Starts a local web dashboard that shows the state of the deployment to the stage. The entry file doesn't have to exist.

```sh
notation dashboard --stage dev
```

The dashboard reads `.notation/workflows.db`, the same database used by deploy, destroy, and plan. Set `NOTATION_DATABASE_PATH` to choose another SQLite database path.
