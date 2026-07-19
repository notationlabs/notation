import {
  Reconciler,
  createLoggerReconcilerSubscriber,
  type ReconcilerEventEmitter,
  type ResourceRegistry,
} from "@notation/reconciler";
import type { StateBackend } from "@notation/state";
import { getResourceGraph } from "src/orchestrator/graph";
import { createDefaultStateBackend } from "../state-backend";

export type DeployAppOptions = {
  entryPoint: string;
  driftDetection?: boolean;
  dryRun?: boolean;
  registry?: ResourceRegistry;
  state?: StateBackend;
  emit?: ReconcilerEventEmitter;
};

export async function deployApp({
  entryPoint,
  driftDetection = true,
  dryRun = false,
  registry,
  state: stateBackend,
  emit = createLoggerReconcilerSubscriber(),
}: DeployAppOptions): Promise<void> {
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
