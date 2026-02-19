import { getResourceGraph } from "src/orchestrator/graph";
import { deleteResource } from "../operations";
import { State } from "../state";
import { refreshState } from "./workflow.refresh";
import type { ResourceRegistry } from "../resource-registry";

export async function destroyApp(entryPoint: string, registry?: ResourceRegistry) {
  console.log(`Destroying ${entryPoint}\n`);

  const graph = await getResourceGraph(entryPoint);
  const state = new State();

  await refreshState(entryPoint, false, registry);

  for (const resource of graph.resources.reverse()) {
    const stateNode = await state.get(resource.id);
    if (!stateNode) {
      console.log(
        `[Skip]: Resource ${resource.type} ${resource.id} not found in state.`,
      );
      continue;
    }
    resource.setOutput(stateNode.output);
    await deleteResource({ resource, state });
  }
}
