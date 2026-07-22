import { createPlan, type Plan } from "@notation/reconciler";
import { getResourceGraph } from "src/orchestrator/graph";
import { NodeYieldStarRuntime } from "../yieldstar-runtime";

export type { Plan, PlanNode, PlanDecision } from "@notation/reconciler";

export type PlanAppOptions = {
  entryPoint: string;
  driftDetection?: boolean;
  runtime?: NodeYieldStarRuntime;
  databasePath?: string;
};

export async function planApp({
  entryPoint,
  driftDetection = true,
  runtime: suppliedRuntime,
  databasePath,
}: PlanAppOptions): Promise<Plan> {
  const graph = await getResourceGraph(entryPoint);
  const runtime =
    suppliedRuntime ??
    new NodeYieldStarRuntime({ deploymentId: entryPoint, databasePath });
  try {
    return await createPlan({
      resources: graph.resources,
      state: runtime.state,
      driftDetection,
    });
  } finally {
    if (!suppliedRuntime) runtime.close();
  }
}
