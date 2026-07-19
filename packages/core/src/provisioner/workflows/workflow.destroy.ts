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
  await refreshState({ entryPoint, registry, state, emit });

  const graph = await getResourceGraph(entryPoint);
  const reconciler = new Reconciler({
    state,
    emit,
  });

  await reconciler.destroy(graph.resources);
}
