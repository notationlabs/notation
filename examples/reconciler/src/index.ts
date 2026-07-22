import { WorkflowRunner } from "@yieldstar/core";
import {
  SqliteHeapClient,
  SqliteSchedulerClient,
  SqliteStoreClient,
  SqliteTaskQueueClient,
  SqliteTimersClient,
  createSqliteDb,
} from "@yieldstar/sqlite-runtime/node";
import {
  YieldStarStateBackend,
  createResourceRegistry,
  reconcileWithYieldStar,
} from "@notation/reconciler";
import pino from "pino";
import { createWorkflowRouter, workflow } from "yieldstar";
import { StaticSite } from "./static-site";

const logger = pino();
const database = createSqliteDb({ path: "sites.db" });
const taskQueueClient = new SqliteTaskQueueClient(database);
const schedulerClient = new SqliteSchedulerClient({
  taskQueueClient,
  timersClient: new SqliteTimersClient(database),
});
const storeClient = new SqliteStoreClient({ db: database, schedulerClient });
const state = new YieldStarStateBackend(storeClient, "static-sites");

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
  yield* reconcileWithYieldStar(step, {
    deploymentId: "static-sites",
    executionId: event.executionId,
    resources,
    state,
    registry: createResourceRegistry([StaticSite]),
  });
});

const runner = new WorkflowRunner({
  router: createWorkflowRouter({ deploy }),
  heapClient: new SqliteHeapClient(database),
  storeClient,
  schedulerClient,
  logger,
});

try {
  await runner.run(
    {
      workflowId: "deploy",
      executionId: crypto.randomUUID(),
      params: {},
      context: new Map(),
    },
    logger,
  );
} finally {
  database.close();
}
