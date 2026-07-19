# notation plan

```sh
notation plan <entryPoint>
```

Compiles the application and reports the changes a deployment would make:

```sh
notation plan infra/api.ts
```

The plan reads remote resources when drift detection applies. It does not perform create,
update, or delete operations.

## JSON output

`--json` writes the complete plan to stdout. Build output and diagnostics move to stderr.

```sh
notation plan infra/api.ts --json > plan.json
```
