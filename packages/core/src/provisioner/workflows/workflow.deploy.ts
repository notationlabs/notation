import {
  Reconciler,
  createLoggerReconcilerSubscriber,
  type ReconcilerEventEmitter,
  type ResourceRegistry,
} from "@notation/reconciler";
import type { StateBackend } from "@notation/state";
import { getResourceGraph } from "src/orchestrator/graph";
import { createDefaultStateBackend } from "../state-backend";

export async function deployApp(
  entryPoint: string,
  driftDetection = true,
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

  await reconciler.deploy(graph.resources, {
    dryRun,
    driftDetection,
  });
}
