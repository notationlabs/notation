# CLI Overview

`@notation/cli` provides the `notation` binary for building, deploying, and inspecting Notation applications. Every command isolates state per stage and selects terminal or JSON output automatically.

## Installation

`@notation/cli` requires **Node.js `>=22.13`**.

Install it as a development dependency so local runs and CI share the same version:

```sh [Terminal]
@pm.dev("@notation/cli")
```

Add scripts to `package.json` to invoke commands without installing the binary globally:

```json [package.json]
{
  "scripts": {
    "notation": "notation",
    "plan": "notation plan",
    "deploy": "notation deploy"
  }
}
```

Run any command through your package manager once the script is configured:

```sh [Terminal]
@pm.run("notation", "plan --stage prod")
```

You can also invoke `./node_modules/.bin/notation` directly or run one-off commands without editing `package.json`:

```sh [Terminal]
@pm.dlx("@notation/cli plan --stage prod")
```

## Commands

The `notation` binary exposes seven subcommands:

| Command | Purpose |
| :--- | :--- |
| [`notation deploy`](./deploy.md) | Compiles your app, checks drift, and converges cloud resources for a stage |
| [`notation plan`](./plan.md) | Previews creates, updates, replacements, and deletions without modifying infrastructure |
| [`notation destroy`](./destroy.md) | Deletes all tracked resources for a stage in reverse dependency order |
| [`notation watch`](./watch.md) | Watches project files and automatically rebuilds and redeploys changes |
| [`notation compile`](./compile.md) | Bundles infrastructure and runtime modules into `dist/` without resolving a stage |
| [`notation dashboard`](./dashboard.md) | Starts a local web UI on port `6682` to inspect live stage state |
| [`notation viz`](./viz.md) | Evaluates the infrastructure graph for a stage and prints a Mermaid Live Editor URL |

## Shared flags

Most commands accept shared flags for project targeting and output formatting (see [CLI Flags](../reference/cli-flags.md) for the full matrix):

| Flag | Purpose |
| :--- | :--- |
| `--config <path>` | Loads a specific `notation.config.ts` and resolves paths from its directory |
| `--stage <stage>` | Overrides `defaultStage` for any command other than `compile` |
| `--json` | Forces JSON output on `deploy`, `plan`, and `destroy` |
| `--pretty` | Forces readable terminal lines on `deploy`, `plan`, and `destroy` |

### `--config`

By default, Notation searches upward from the working directory for `notation.config.ts`. Passing `--config <path>` loads a specific config file and resolves project paths from its directory.

Pass `--config` to target an application outside your current working directory:

```sh [Terminal]
@pm.run("notation", "plan --config apps/orders/notation.config.ts --stage prod")
```

`plan`, `deploy`, and `destroy` preserve `--config` in printed follow-up and resume commands.

### `--stage`

Every command except `compile` targets an `<app>:<stage>` deployment. Pass `--stage <stage>` to override `defaultStage` in `notation.config.ts`.

Target a stage on the command line without editing `notation.config.ts`:

```sh [Terminal]
@pm.run("notation", "deploy --stage prod")
```

If neither `--stage` nor `defaultStage` is set, the command exits with an error. When resuming `deploy` or `destroy` with `--execution-id`, omit `--stage` so Notation reads the saved stage from state.

## Output formatting

`deploy`, `plan`, and `destroy` format output for humans in interactive terminals and CI, and switch to JSON automatically when piped outside CI. Pass `--json` to force JSON output (`Plan` JSON for `plan`, NDJSON events for `deploy` and `destroy`) or `--pretty` to force readable lines when piping.

Pipe `notation plan --json` directly into tools like `jq` because logs and diagnostics redirect to `stderr`:

```sh [Terminal]
./node_modules/.bin/notation plan --json --stage prod | jq '.nodes[] | { id, decision }'
```

During `deploy --json` or `destroy --json`, each line on `stdout` carries `"version": 1` alongside the reconciler payload:

```json [stdout (NDJSON)]
{"version":1,"level":"info","event":"reconciler.deploy.decision","resourceId":"orderQueue","resourceType":"aws/sqs/Queue","decision":"create"}
```

## Error handling

Stack frames originating inside compiled `dist/` bundles map back to your original `.ts` files and line numbers. Before printing any thrown error to `stderr`, the CLI scrubs recorded secret values with `<hidden>` and prints setup guidance when AWS credentials are missing.

When AWS credentials cannot be resolved during `deploy`, the CLI writes setup instructions to `stderr`:

```text [stderr]
AWS credentials not found.

Ensure you have a default profile set up in ~/.aws/credentials.

If using another profile run AWS_PROFILE=otherProfile notation deploy.
```

## Exit codes

Commands exit with `0` on success and `1` on runtime errors, validation failures, or invalid CLI flags. [`notation watch`](./watch.md) also exits with `1` after finishing any active deploy if `notation.config.ts` changes.
