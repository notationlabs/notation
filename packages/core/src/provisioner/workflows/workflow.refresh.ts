import { getResourceGraph } from "src/orchestrator/graph";
import { deleteResource } from "../operations/operation.delete";
import { State } from "../state";
import { BaseResource } from "src/orchestrator/resource";
import {
  createMissingResourceRegistryMatchWarningEvent,
  createResourceRegistryFromGraph,
  resolveResourceClass,
  ResourceRegistry,
} from "../resource-registry";

/**
 * @description Destroy resources that are in state but not in the orchestration graph
 */
export async function refreshState(
  entryPoint: string,
  dryRun = false,
  registry?: ResourceRegistry,
): Promise<void> {
  const log = (message: string) =>
    dryRun ? console.log(`[Dry Run]: ${message}`) : console.log(message);

  log(`Refreshing ${entryPoint} state\n`);

  const graph = await getResourceGraph(entryPoint);
  const state = new State();
  const resourceRegistry = registry ?? createResourceRegistryFromGraph(graph.resources);

  for (const stateNode of (await state.values()).reverse()) {
    let resource = graph.resources.find((r) => r.id === stateNode.id);

    if (!resource) {
      const Resource = resolveResourceClass(resourceRegistry, stateNode.type);

      if (!Resource) {
        console.warn(
          JSON.stringify(
            createMissingResourceRegistryMatchWarningEvent({
              workflow: "refresh",
              resourceId: stateNode.id,
              resourceType: stateNode.type,
            }),
          ),
        );
        continue;
      }

      resource = new Resource({
        id: stateNode.id,
        config: stateNode.config,
      }) as BaseResource;

      resource.setOutput(stateNode.output);

      if (!dryRun) {
        await deleteResource({ resource, state, dryRun });
      }

      log(`Deleted ${resource.type} ${resource.id}`);
    }
  }
}
