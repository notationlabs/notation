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
