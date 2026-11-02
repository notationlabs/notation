# notation viz

```sh
notation viz [--config <path>]
```

| Option            | Meaning                                                     |
| ----------------- | ----------------------------------------------------------- |
| `--config <path>` | The config file. Default: the nearest `notation.config.ts`. |

Generates a graph of the entry file's resources and their dependencies. Outputs a Mermaid Live Editor URL.

```sh
notation viz
```

Shows the full resource graph – API Gateway, Lambda functions, IAM roles, integrations, routes, log groups – and their dependency relationships.
