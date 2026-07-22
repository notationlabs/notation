import * as reconciler from "@notation/reconciler";
import {
  createLoggerReconcilerSubscriber,
  type ReconcilerEventEmitter,
  type ResourceRegistry,
} from "@notation/reconciler";
import { createWorkflowRouter, workflow } from "yieldstar";
import { getResourceGraph } from "src/orchestrator/graph";
import { NodeDurableRuntime, resolveDeploymentId } from "../durable-runtime";

export type DeployAppOptions = {
  entryPoint: string;
  driftDetection?: boolean;
  dryRun?: boolean;
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
  registry,
  runtime: suppliedRuntime,
  executionId,
  databasePath,
  emit = createLoggerReconcilerSubscriber(),
}: DeployAppOptions): Promise<void> {
  const graph = await getResourceGraph(entryPoint);
  const deploymentId =
    suppliedRuntime?.deploymentId ?? resolveDeploymentId(entryPoint);
  const runtime =
    suppliedRuntime ?? new NodeDurableRuntime({ deploymentId, databasePath });
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
    });
  });
  try {
    await runtime.run(createWorkflowRouter({ deploy }), {
      workflowId: "deploy",
      executionId,
    });
  } finally {
    if (!suppliedRuntime) runtime.close();
  }
}
