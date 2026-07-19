# Reconciler

Use the reconciler directly when a Node.js application needs to deploy resources without
starting the Notation CLI.

This complete program deploys two static sites and keeps their deployment state in
SQLite:

```ts
import { Reconciler, createResourceRegistry } from "@notation/reconciler";
import { SqliteStateBackend } from "@notation/state-sqlite";
import { StaticSite } from "./static-site";

const state = new SqliteStateBackend("sites.db");

const resources = [
  new StaticSite({
    id: "documentation",
    config: {
      siteDirectory: "sites/docs",
      html: "<h1>Documentation</h1>\n",
    },
  }),
  new StaticSite({
    id: "status",
    config: {
      siteDirectory: "sites/status",
      html: "<h1>All systems operational</h1>\n",
    },
  }),
];

const reconciler = new Reconciler({
  state,
  registry: createResourceRegistry([StaticSite]),
});

try {
  await reconciler.deploy(resources);
} finally {
  state.close();
}
```

`StaticSite` contains the provider operations which create, read, update, and delete a
site. A real provider would call its infrastructure API instead of writing local files.

Pass the complete desired set to `deploy`. A resource which remains in deployment state
but is absent from that set is deleted. The explicit registry lets the reconciler find
its delete operation.

Notation's state records what was deployed. It does not replace application data which
owns the desired configuration.

The runnable version is in `examples/reconciler`.
