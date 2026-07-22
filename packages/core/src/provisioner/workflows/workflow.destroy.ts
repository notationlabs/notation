import {
  destroyWithYieldstar,
  createLoggerReconcilerSubscriber,
  type ReconcilerEventEmitter,
  type ResourceRegistry,
} from "@notation/reconciler";
import { createWorkflowRouter, workflow } from "yieldstar";
import { getResourceGraph } from "src/orchestrator/graph";
import { NodeYieldstarRuntime } from "../yieldstar-runtime";

export type DestroyAppOptions = {
  entryPoint: string;
  registry?: ResourceRegistry;
  runtime?: NodeYieldstarRuntime;
  executionId?: string;
  databasePath?: string;
  emit?: ReconcilerEventEmitter;
};

export async function destroyApp({
  entryPoint,
  registry,
  runtime: suppliedRuntime,
  executionId,
  databasePath,
  emit = createLoggerReconcilerSubscriber(),
}: DestroyAppOptions) {
  const graph = await getResourceGraph(entryPoint);
  const runtime =
    suppliedRuntime ??
    new NodeYieldstarRuntime({ deploymentId: entryPoint, databasePath });
  const destroy = workflow(async function* (step, event) {
    yield* destroyWithYieldstar(step, {
      deploymentId: runtime.deploymentId,
      executionId: event.executionId,
      resources: graph.resources,
      state: runtime.state,
      registry,
      emit,
    });
  });
  try {
    await runtime.run(createWorkflowRouter({ destroy }), {
      workflowId: "destroy",
      executionId,
    });
  } finally {
    if (!suppliedRuntime) runtime.close();
  }
}
