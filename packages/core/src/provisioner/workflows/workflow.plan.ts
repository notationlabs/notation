import {
  createLoggerReconcilerSubscriber,
  createPlan,
  type Plan,
  type ReconcilerEventEmitter,
} from "@notation/reconciler";
import { getResourceGraph } from "src/orchestrator/graph";
import { withRuntime, type NodeDurableRuntime } from "../durable-runtime";

export type { Plan, PlanNode, PlanDecision } from "@notation/reconciler";

export type PlanAppOptions = {
  entryPoint: string;
  driftDetection?: boolean;
  maxOperationAttempts?: number;
  runtime?: NodeDurableRuntime;
  databasePath?: string;
  emit?: ReconcilerEventEmitter;
};

export async function planApp({
  entryPoint,
  // Defaulted in one place: the reconciler's drift gate treats absent as on.
  driftDetection,
  maxOperationAttempts,
  runtime: suppliedRuntime,
  databasePath,
  emit = createLoggerReconcilerSubscriber(),
}: PlanAppOptions): Promise<Plan> {
  const graph = await getResourceGraph(entryPoint);
  return withRuntime(
    { entryPoint, runtime: suppliedRuntime, databasePath },
    (runtime) =>
      createPlan({
        resources: graph.resources,
        state: runtime.state,
        driftDetection,
        emit,
        maxOperationAttempts,
      }),
  );
}
