import * as reconciler from "@notation/reconciler/durable";
import {
  createLoggerReconcilerSubscriber,
  type ReconcilerEventEmitter,
  type ResourceRegistry,
} from "@notation/reconciler";
import { createWorkflowRouter, workflow } from "yieldstar";
import { getResourceGraph } from "src/orchestrator/graph";
import { withRuntime, type NodeDurableRuntime } from "../durable-runtime";

export type DeployAppOptions = {
  entryPoint: string;
  driftDetection?: boolean;
  dryRun?: boolean;
  maxOperationAttempts?: number;
  registry?: ResourceRegistry;
  runtime?: NodeDurableRuntime;
  executionId?: string;
  databasePath?: string;
  emit?: ReconcilerEventEmitter;
};

export async function deployApp({
  entryPoint,
  driftDetection = true,
  dryRun = false,
  maxOperationAttempts,
  registry,
  runtime: suppliedRuntime,
  executionId,
  databasePath,
  emit = createLoggerReconcilerSubscriber(),
}: DeployAppOptions): Promise<void> {
  const graph = await getResourceGraph(entryPoint);
  await withRuntime(
    { entryPoint, runtime: suppliedRuntime, databasePath },
    async (runtime) => {
      const deploy = workflow(async function* (step, event) {
        yield* reconciler.deploy(step, {
          deploymentId: runtime.deploymentId,
          executionId: event.executionId,
          resources: graph.resources,
          state: runtime.state,
          registry,
          emit,
          dryRun,
          driftDetection,
          maxOperationAttempts,
        });
      });
      await runtime.run(createWorkflowRouter({ deploy }), {
        workflowId: "deploy",
        executionId,
      });
    },
  );
}
