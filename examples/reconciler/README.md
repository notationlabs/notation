# Reconciler

This example deploys two static sites from an ordinary Node.js program. It does not
compile a Notation project or start the Notation CLI.

[`src/index.ts`](./src/index.ts) is the complete program. It defines the desired
resources inline, opens a SQLite state backend, and passes the resources directly to the
reconciler. [`src/static-site.ts`](./src/static-site.ts) defines the local provider
operations used to create, read, update, and delete each site.

Run it from the repository root:

```sh
pnpm --filter reconciler-example demo
```

The generated sites are written to `sites/`, and deployment state is stored in
`sites.db`. Change the resource configuration and run the command again to update the
sites. Remove a resource from the array and run it again to delete that site.

Run the integration test with:

```sh
pnpm --filter reconciler-example test
```
