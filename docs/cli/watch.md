# notation watch

```sh
notation watch <entryPoint>
```

Hot Infra Replacement – the development workflow.

```sh
notation watch infra/api.ts
```

## What it does

1. Compiles infra and runtime with esbuild in watch mode.
2. Deploys the initial stack.
3. Watches `dist/` for changes (debounced at 500ms).
4. On change, redeploys – only changed resources are updated (same reconciler as `deploy`).
5. Queues deploys if one is already in progress.

This gives you a live dev stack on real AWS infrastructure. Each developer can spin up their own ephemeral stack, iterate, and tear it down with `notation destroy`.

Production deployments use `notation deploy`, not `watch`.
