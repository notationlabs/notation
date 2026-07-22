import { createPlan, type Plan } from "@notation/reconciler";
import { getResourceGraph } from "src/orchestrator/graph";
import { NodeDurableRuntime, resolveDeploymentId } from "../durable-runtime";

export type { Plan, PlanNode, PlanDecision } from "@notation/reconciler";

export type PlanAppOptions = {
  entryPoint: string;
  driftDetection?: boolean;
  runtime?: NodeDurableRuntime;
  databasePath?: string;
};

export async function planApp({
  entryPoint,
  driftDetection = true,
  runtime: suppliedRuntime,
  databasePath,
}: PlanAppOptions): Promise<Plan> {
  const graph = await getResourceGraph(entryPoint);
  const deploymentId =
    suppliedRuntime?.deploymentId ?? resolveDeploymentId(entryPoint);
  const runtime =
    suppliedRuntime ?? new NodeDurableRuntime({ deploymentId, databasePath });
  try {
    await runtime.initialize();
    return await createPlan({
      resources: graph.resources,
      state: runtime.state,
      driftDetection,
    });
  } finally {
    if (!suppliedRuntime) runtime.close();
  }
}
