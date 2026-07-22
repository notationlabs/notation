import { NodeDurableRuntime } from "@notation/core";
import * as reconciler from "@notation/reconciler";
import { createWorkflowRouter, workflow } from "yieldstar";
import { StaticSite } from "./static-site";

const runtime = new NodeDurableRuntime({
  deploymentId: "static-sites",
  databasePath: "sites.db",
});

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

const deploy = workflow(async function* (step, event) {
  yield* reconciler.deploy(step, {
    deploymentId: "static-sites",
    executionId: event.executionId,
    resources,
    state: runtime.state,
    registry: reconciler.createResourceRegistry([StaticSite]),
  });
});

try {
  await runtime.run(createWorkflowRouter({ deploy }), {
    workflowId: "deploy",
  });
} finally {
  runtime.close();
}
