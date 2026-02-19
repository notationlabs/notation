import {
  Reconciler,
  createConsoleReconcilerSubscriber,
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
): Promise<void> {
  console.log(`${dryRun ? "[Dry Run]: " : ""}Refreshing ${entryPoint} state\n`);

  const graph = await getResourceGraph(entryPoint);
  const state = stateBackend ?? createDefaultStateBackend();

  const reconciler = new Reconciler({
    state,
    registry,
    emit: createConsoleReconcilerSubscriber(),
  });

  await reconciler.refresh(graph.resources, { dryRun });
}
