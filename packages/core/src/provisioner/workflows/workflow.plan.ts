import {
  Reconciler,
  createLoggerReconcilerSubscriber,
  type Plan,
  type ReconcilerEventEmitter,
  type ResourceRegistry,
} from "@notation/reconciler";
import type { StateBackend } from "@notation/state";
import { getResourceGraph } from "src/orchestrator/graph";
import { createDefaultStateBackend } from "../state-backend";

export type { Plan, PlanNode, PlanDecision } from "@notation/reconciler";

export type PlanAppOptions = {
  entryPoint: string;
  driftDetection?: boolean;
  registry?: ResourceRegistry;
  state?: StateBackend;
  emit?: ReconcilerEventEmitter;
};

export async function planApp({
  entryPoint,
  driftDetection = true,
  registry,
  state: stateBackend,
  emit = createLoggerReconcilerSubscriber(),
}: PlanAppOptions): Promise<Plan> {
  const graph = await getResourceGraph(entryPoint);
  const state = stateBackend ?? createDefaultStateBackend();
  const reconciler = new Reconciler({
    state,
    registry,
    emit,
  });

  return reconciler.plan(graph.resources, { driftDetection });
}
