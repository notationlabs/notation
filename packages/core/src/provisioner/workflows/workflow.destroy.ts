import {
  Reconciler,
  createConsoleReconcilerSubscriber,
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
) {
  console.log(`Destroying ${entryPoint}\n`);

  const state = stateBackend ?? createDefaultStateBackend();

  await refreshState(entryPoint, false, registry, state);

  const graph = await getResourceGraph(entryPoint);
  const reconciler = new Reconciler({
    state,
    emit: createConsoleReconcilerSubscriber(),
  });

  await reconciler.destroy(graph.resources);
}
