import { createPlan, type Plan } from "@notation/reconciler";
import { getResourceGraph } from "src/orchestrator/graph";
import { withRuntime, type NodeDurableRuntime } from "../durable-runtime";

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
  return withRuntime(
    { entryPoint, runtime: suppliedRuntime, databasePath },
    async (runtime) => {
      await runtime.initialize();
      return createPlan({
        resources: graph.resources,
        state: runtime.state,
        driftDetection,
        maxOperationAttempts,
      });
    },
  );
}
