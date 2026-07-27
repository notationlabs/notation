import {
  Reconciler,
  createLoggerReconcilerSubscriber,
  type ReconcilerEventEmitter,
  type ResourceRegistry,
} from "@notation/reconciler";
import type { StateBackend } from "@notation/state";
import { getResourceGraph } from "src/orchestrator/graph";
import { createDefaultStateBackend } from "../state-backend";

export type DestroyAppOptions = {
  entryPoint: string;
  registry?: ResourceRegistry;
  state?: StateBackend;
  emit?: ReconcilerEventEmitter;
};

export async function destroyApp({
  entryPoint,
  registry,
  state: stateBackend,
  emit = createLoggerReconcilerSubscriber(),
}: DestroyAppOptions) {
  const state = stateBackend ?? createDefaultStateBackend();
  const graph = await getResourceGraph(entryPoint);

  // The registry has to be threaded through: destroy sweeps orphans itself
  // now, and without one the sweep falls back to the types of the resources
  // still declared — so an orphan whose type the app no longer declares would
  // be skipped with a warning instead of deleted. The parameter is optional,
  // so nothing but this would catch it.
  const reconciler = new Reconciler({
    state,
    registry,
    emit,
  });

  await reconciler.destroy(graph.resources);
}
