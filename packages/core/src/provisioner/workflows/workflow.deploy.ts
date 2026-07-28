import * as durable from "@notation/reconciler/durable";
import {
  createLoggerReconcilerSubscriber,
  type ReconcilerEventEmitter,
  type ResourceRegistry,
} from "@notation/reconciler";
import { getResourceGraph } from "src/orchestrator/graph";
import { runDurableWorkflow, type NodeDurableRuntime } from "../durable-runtime";

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
  runtime,
  executionId,
  databasePath,
  emit = createLoggerReconcilerSubscriber(),
}: DeployAppOptions): Promise<void> {
  const graph = await getResourceGraph(entryPoint);
  await runDurableWorkflow(
    { entryPoint, workflowId: "deploy", runtime, databasePath, executionId },
    (step, executionId, runtime) =>
      durable.deploy(step, {
        executionId,
        resources: graph.resources,
        state: runtime.state,
        registry,
        emit,
        dryRun,
        driftDetection,
        maxOperationAttempts,
      }),
  );
}
