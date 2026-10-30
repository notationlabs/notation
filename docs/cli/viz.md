# notation viz

```sh
notation viz <entry>
```

| Argument  | Meaning                                                 |
| --------- | ------------------------------------------------------- |
| `<entry>` | An entry name from `notation.config.ts`, such as `api`. |

Generates a visual graph of the entry's resources and their dependencies. Outputs a Mermaid Live Editor URL.

```sh
notation viz api
```

Shows the full resource graph – API Gateway, Lambda functions, IAM roles, integrations, routes, log groups – and their dependency relationships.
