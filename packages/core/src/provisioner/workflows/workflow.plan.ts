import {
  Reconciler,
  createConsoleReconcilerSubscriber,
  type Plan,
  type ReconcilerEventEmitter,
  type ResourceRegistry,
} from "@notation/reconciler";
import type { StateBackend } from "@notation/state";
import { getResourceGraph } from "src/orchestrator/graph";
import { createDefaultStateBackend } from "../state-backend";

export type { Plan, PlanNode, PlanDecision } from "@notation/reconciler";

export async function planApp(
  entryPoint: string,
  driftDetection = true,
  registry?: ResourceRegistry,
  stateBackend?: StateBackend,
  emit: ReconcilerEventEmitter = createConsoleReconcilerSubscriber(),
): Promise<Plan> {
  const graph = await getResourceGraph(entryPoint);
  const state = stateBackend ?? createDefaultStateBackend();
  const reconciler = new Reconciler({
    state,
    registry,
    emit,
  });

  return reconciler.plan(graph.resources, { driftDetection });
}
