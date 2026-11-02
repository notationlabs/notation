# notation viz

```sh
notation viz [--config <path>]
```

| Argument          | Meaning                                                        |
| ----------------- | -------------------------------------------------------------- |
| `--config <path>` | The config file. Defaults to the nearest `notation.config.ts`. |

Generates a visual graph of the entry's resources and their dependencies. Outputs a Mermaid Live Editor URL.

```sh
notation viz
```

Shows the full resource graph – API Gateway, Lambda functions, IAM roles, integrations, routes, log groups – and their dependency relationships.
