# Durable reconciler

This example deploys two static sites from an ordinary Node.js program using Yieldstar 0.5.0 for durable execution, state, retries, waiting, and deployment coordination.

[`src/index.ts`](./src/index.ts) owns the outer workflow and Node SQLite runtime. It passes Yieldstar's `step` context to `deployWithYieldstar`, while [`src/static-site.ts`](./src/static-site.ts) contains only the desired resources and provider lifecycle operations.

Run it from the repository root:

```sh
pnpm --filter reconciler-example demo
```

The generated sites are written to `sites/`, and the workflow heap, resource stores, timers, and coordination state are stored in `sites.db`. Change the resource configuration and run the command again to update the sites. Remove a resource from the array and run it again to delete that site.

Run the integration test with:

```sh
pnpm --filter reconciler-example test
```
