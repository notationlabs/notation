# notation watch

```sh
notation watch <entry> [--stage <stage>]
```

| Argument          | Meaning                                                            |
| ----------------- | ------------------------------------------------------------------ |
| `<entry>`         | An entry name from `notation.config.ts`, such as `api`.            |
| `--stage <stage>` | The stage. Defaults to `defaultStage`, and is required without it. |

Hot Infra Replacement – the development workflow.

```sh
notation watch api --stage dev
```

## What it does

1. Compiles infra and runtime with esbuild in watch mode.
2. Deploys the initial stack.
3. Watches `dist/` for changes (debounced at 500ms).
4. On change, redeploys – only changed resources are updated (same reconciler as `deploy`).
5. Queues deploys if one is already in progress.

This gives you a live dev stack on real AWS infrastructure. Each developer can spin up their own ephemeral stack, iterate, and tear it down with `notation destroy`.

Production deployments use `notation deploy`, not `watch`.
