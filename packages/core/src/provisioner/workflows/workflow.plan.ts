import { createPlan, type Plan } from "@notation/reconciler";
import { getResourceGraph } from "src/orchestrator/graph";
import { NodeDurableRuntime } from "../durable-runtime";

export type { Plan, PlanNode, PlanDecision } from "@notation/reconciler";

export type PlanAppOptions = {
  entryPoint: string;
  driftDetection?: boolean;
  maxOperationAttempts?: number;
  runtime?: NodeDurableRuntime;
  databasePath?: string;
};

export async function planApp({
  entryPoint,
  driftDetection = true,
  maxOperationAttempts,
  runtime: suppliedRuntime,
  databasePath,
}: PlanAppOptions): Promise<Plan> {
  const graph = await getResourceGraph(entryPoint);
  const runtime =
    suppliedRuntime ??
    new NodeDurableRuntime({ deploymentId: entryPoint, databasePath });
  try {
    return await createPlan({
      resources: graph.resources,
      state: runtime.state,
      driftDetection,
      maxOperationAttempts,
    });
  } finally {
    if (!suppliedRuntime) runtime.close();
  }
}
