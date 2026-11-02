# notation watch

```sh
notation watch [--config <path>] [--stage <stage>]
```

| Option            | Meaning                                                     |
| ----------------- | ----------------------------------------------------------- |
| `--config <path>` | The config file. Default: the nearest `notation.config.ts`. |
| `--stage <stage>` | The stage. Default: `defaultStage`.                         |

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

`watch` reads the config once, when it starts. If the config file changes, `watch` waits for any running deploy to finish, then exits with code 1. Start `watch` again to use the new config.

`watch` deploys real AWS resources. Several developers can share one AWS account if each developer uses their own stage, such as `--stage dev-alice`, because [AWS names](../manual/project-config.md#aws-names) contain the stage. To remove the resources of the stage, run `notation destroy --stage dev-alice`.

Production deployments use `notation deploy`, not `watch`.
