import {
  Reconciler,
  createLoggerReconcilerSubscriber,
  type ReconcilerEventEmitter,
  type ResourceRegistry,
} from "@notation/reconciler";
import type { StateBackend } from "@notation/state";
import { getResourceGraph } from "src/orchestrator/graph";
import { createDefaultStateBackend } from "../state-backend";
import { refreshState } from "./workflow.refresh";

export async function destroyApp(
  entryPoint: string,
  registry?: ResourceRegistry,
  stateBackend?: StateBackend,
  emit: ReconcilerEventEmitter = createLoggerReconcilerSubscriber(),
) {
  const state = stateBackend ?? createDefaultStateBackend();

  await refreshState(entryPoint, false, registry, state, emit);

  const graph = await getResourceGraph(entryPoint);
  const reconciler = new Reconciler({
    state,
    emit,
  });

  await reconciler.destroy(graph.resources);
}
