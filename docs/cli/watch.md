# notation watch

`notation watch` monitors your project during local development and automatically recompiles and redeploys changes to a target stage whenever source files are saved.

## Usage

Start watch mode for `defaultStage` from your project root:

```sh [Terminal]
@pm.dlx("notation watch")
```

You can also add a `watch` script to `package.json` for local development:

```json [package.json]
{
  "scripts": {
    "watch": "notation watch"
  }
}
```

Run the script with your package manager:

```sh [Terminal]
@pm.run("watch")
```

## Options

`notation watch` supports `--config` and `--stage` to target a project config or stage. If neither `--stage` nor `defaultStage` is set, `watch` exits with an error before compiling.

Target a specific stage or config file on the command line:

```sh [Terminal]
@pm.dlx("notation watch --stage staging")
@pm.dlx("notation watch --config orders.config.ts --stage dev")
```

## Watch workflow

`watch` pairs incremental compilation with file watchers to redeploy changes automatically.

### Initial build

When `watch` starts, it compiles your infrastructure `entry` first. If the initial build fails, `watch` logs the error and waits until a valid build succeeds before deploying.

### Watched files

`watch` monitors your infrastructure entrypoint, `files.runtime` modules, and files imported by resource bundles (including linked workspace packages). `node_modules/` and dot-directories such as `.notation/` are ignored so state writes never trigger rebuild loops.

### Coalesced redeploys

Rapid edits are debounced into a single deploy. Edits saved during an active deploy queue one follow-up deploy instead of interrupting the running deployment.

## Config file changes

`watch` loads configuration once at startup and does not hot-reload config changes. If the config file changes, `watch` prints `<configFile> changed. Restart watch to use the new config.`, finishes any active deploy, and exits with code `1`.

## Watch deploy behavior

Each rebuild runs a fresh deploy with a new execution ID and differs from [`notation deploy`](./deploy.md) in four ways:

| Aspect | Behavior |
| :--- | :--- |
| Compilation | Reuses the `dist/` build maintained by `watch` without rebuilding |
| Drift detection | Skips live `read` checks to keep local redeploys fast |
| Output formatting | Streams `pretty` events to the terminal with non-interactive `stdin` |
| Signal handling | Forwards `SIGINT` and `SIGTERM` to an active deploy before exiting |

Run [`notation plan`](./plan.md) when you need to check remote drift.

## Credential handling

`notation watch` never prompts interactively for secrets and does not accept `--credential` or `--replace`. Credentials from [secret sources](../core/secrets.md) and resources with automated `rotate` operations resolve automatically during watch deploys.

When a deploy requires a non-rotatable credential whose value is not in memory, the deploy fails with `UnobtainableCredentialError` while `watch` keeps running for future edits:

```text [stderr]
UnobtainableCredentialError: `orders-api` is new, and takes `webhook.signingSecret`. Notation does not store the value, and `orders/WebhookEndpoint` has no operation that issues another.

  Issue a new value of `signingSecret` at the provider of `orders/WebhookEndpoint`. Then set the environment variable `WEBHOOK_SIGNING_SECRET` to the value, and pass it:
    notation deploy --config /path/to/notation.config.ts --stage dev --credential webhook.signingSecret@5d2e8b17=WEBHOOK_APP_SIGNING_SECRET

  Or replace `webhook`. Deploy deletes `webhook` and creates it again with a new value, so whatever exists only in the old `webhook` is lost:
    notation deploy --config /path/to/notation.config.ts --stage dev --replace webhook@5d2e8b17
Error: Deploy exited with code 1
```

Export the environment variable and run the printed `notation deploy` command once in another terminal:

```sh [Terminal]
export WEBHOOK_SIGNING_SECRET="whsec_..."
@pm.dlx("notation deploy --stage dev --credential webhook.signingSecret@5d2e8b17=WEBHOOK_SIGNING_SECRET")
```

Once that manual deploy updates state, automatic redeploys in `watch` continue normally.
