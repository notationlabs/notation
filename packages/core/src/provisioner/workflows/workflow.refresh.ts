import {
  Reconciler,
  createLoggerReconcilerSubscriber,
  type ReconcilerEventEmitter,
  type ResourceRegistry,
} from "@notation/reconciler";
import type { StateBackend } from "@notation/state";
import { getResourceGraph } from "src/orchestrator/graph";
import { createDefaultStateBackend } from "../state-backend";

/**
 * @description Destroy resources that are in state but not in the orchestration graph
 */
export type RefreshStateOptions = {
  entryPoint: string;
  dryRun?: boolean;
  registry?: ResourceRegistry;
  state?: StateBackend;
  emit?: ReconcilerEventEmitter;
};

export async function refreshState({
  entryPoint,
  dryRun = false,
  registry,
  state: stateBackend,
  emit = createLoggerReconcilerSubscriber(),
}: RefreshStateOptions): Promise<void> {
  const graph = await getResourceGraph(entryPoint);
  const state = stateBackend ?? createDefaultStateBackend();

  const reconciler = new Reconciler({
    state,
    registry,
    emit,
  });

  await reconciler.refresh(graph.resources, { dryRun });
}
