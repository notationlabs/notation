# notation watch

```sh
notation watch [--config <path>] [--stage <stage>]
```

| Argument          | Meaning                                                            |
| ----------------- | ------------------------------------------------------------------ |
| `--config <path>` | The config file. Defaults to the nearest `notation.config.ts`.     |
| `--stage <stage>` | The stage. Defaults to `defaultStage`, and is required without it. |

Hot Infra Replacement – the development workflow.

```sh
notation watch --stage dev
```

## What it does

1. Compiles infra and runtime with esbuild in watch mode.
2. Deploys the initial stack.
3. Watches `dist/` for changes (debounced at 500ms).
4. On change, redeploys – only changed resources are updated (same reconciler as `deploy`).
5. Queues deploys if one is already in progress.

## Changing the config

`watch` reads the config file once, when it starts, and compiles the entry file that the config names at that time. When the config file changes, `watch` waits for a running deploy to finish and then exits with code 1. Run `watch` again to use the new config.

`watch` deploys to real AWS resources. To give each developer their own copy, run `watch` with a stage per developer, such as `--stage dev-alice`, and remove the copy with `notation destroy --stage dev-alice`. The [AWS names](../manual/project-config.md#aws-names) of each stage start with the app and the stage, so the developers can share one AWS account.

Production deployments use `notation deploy`, not `watch`.
