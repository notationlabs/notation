import {
  Reconciler,
  createConsoleReconcilerSubscriber,
  type ResourceRegistry,
} from "@notation/reconciler";
import { getResourceGraph } from "src/orchestrator/graph";
import { State } from "../state";
import { refreshState } from "./workflow.refresh";

export async function destroyApp(entryPoint: string, registry?: ResourceRegistry) {
  console.log(`Destroying ${entryPoint}\n`);

  await refreshState(entryPoint, false, registry);

  const graph = await getResourceGraph(entryPoint);
  const state = new State();
  const reconciler = new Reconciler({
    state,
    emit: createConsoleReconcilerSubscriber(),
  });

  await reconciler.destroy(graph.resources);
}
