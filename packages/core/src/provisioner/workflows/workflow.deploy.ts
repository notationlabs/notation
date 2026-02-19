import {
  Reconciler,
  createConsoleReconcilerSubscriber,
  type ResourceRegistry,
} from "@notation/reconciler";
import { getResourceGraph } from "src/orchestrator/graph";
import { State } from "../state";

export async function deployApp(
  entryPoint: string,
  driftDetection = true,
  dryRun = false,
  registry?: ResourceRegistry,
): Promise<void> {
  const graph = await getResourceGraph(entryPoint);
  const state = new State();
  const reconciler = new Reconciler({
    state,
    registry,
    emit: createConsoleReconcilerSubscriber(),
  });

  await reconciler.deploy(graph.resources, {
    dryRun,
    driftDetection,
  });
}
