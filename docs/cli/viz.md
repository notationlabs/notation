# notation viz

```sh
notation viz [--config <path>] [--stage <stage>]
```

| Option            | Meaning                                                     |
| ----------------- | ----------------------------------------------------------- |
| `--config <path>` | The config file. Default: the nearest `notation.config.ts`. |
| `--stage <stage>` | The stage. Default: `defaultStage`.                         |

Generates a graph of the entry file's resources and their dependencies. Outputs a Mermaid Live Editor URL. The infra code is evaluated for the stage, as deploy evaluates it, so [`deployment()`](../manual/secrets.md#a-value-that-depends-on-the-stage) returns the app and the stage.

```sh
notation viz
```

Shows the full resource graph – API Gateway, Lambda functions, IAM roles, integrations, routes, log groups – and their dependency relationships.
