import { randomUUID } from "node:crypto";
import { NodeDurableRuntime } from "@notation/core";
import { createResourceRegistry } from "@notation/reconciler";
import * as durable from "@notation/reconciler/durable";
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
  yield* durable.deploy(step, {
    executionId: event.executionId,
    resources,
    state: runtime.state,
    registry: createResourceRegistry([StaticSite]),
  });
});

// The resume handle for this run: rerunning with the same ID replays
// checkpointed work instead of repeating it.
const executionId = randomUUID();
console.log(`Execution ID ${executionId}`);

try {
  await runtime.run(createWorkflowRouter({ deploy }), {
    workflowId: "deploy",
    executionId,
  });
} finally {
  runtime.close();
}
