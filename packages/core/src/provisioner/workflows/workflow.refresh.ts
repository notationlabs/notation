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
export async function refreshState(
  entryPoint: string,
  dryRun = false,
  registry?: ResourceRegistry,
  stateBackend?: StateBackend,
  emit: ReconcilerEventEmitter = createLoggerReconcilerSubscriber(),
): Promise<void> {
  const graph = await getResourceGraph(entryPoint);
  const state = stateBackend ?? createDefaultStateBackend();

  const reconciler = new Reconciler({
    state,
    registry,
    emit,
  });

  await reconciler.refresh(graph.resources, { dryRun });
}
