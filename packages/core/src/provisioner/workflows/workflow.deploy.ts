import { getResourceGraph } from "src/orchestrator/graph";
import { createResource } from "../operations/operation.create";
import { readResource } from "../operations/operation.read";
import { updateResource } from "../operations/operation.update";
import { deleteResource } from "../operations/operation.delete";
import { State } from "../state";
import * as deepDiff from "deep-object-diff";
import { BaseResource } from "src/orchestrator/resource";
import {
  createResourceRegistryFromGraph,
  resolveResourceClass,
  ResourceRegistry,
} from "../resource-registry";

export async function deployApp(
  entryPoint: string,
  driftDetection = true,
  dryRun = false,
  registry?: ResourceRegistry,
): Promise<void> {
  const graph = await getResourceGraph(entryPoint);
  const state = new State();
  const resourceRegistry = registry ?? createResourceRegistryFromGraph(graph.resources);

  for (const resource of graph.resources) {
    const stateNode = await state.get(resource.id);

    // 1. Has resource been created before?
    if (!stateNode) {
      await createResource({ resource, state, dryRun });
      continue;
    }

    // 2. Assign existing state output to resource
    // todo: get hidden fields (or read live resource and check drift first?)
    resource.setOutput(stateNode.output);

    // 3. Have the desired params changed from the state?
    const params = await resource.getParams();

    // diff to transition from last state to current params
    const localDiff = deepDiff.diff(
      resource.toComparable(stateNode.params),
      resource.toComparable(params),
    );

    // todo: what should happen if a property is undefined?
    // should it be ignored?
    const stateIsStale = Object.keys(localDiff).length > 0;

    if (stateIsStale) {
      console.log(`Resource ${resource.id} has changed. Updating...`);
      await updateResource({ resource, state, patch: localDiff, dryRun });
      continue;
    }

    if (!driftDetection) continue;

    const latestOutput = await readResource({
      resource,
      state,
      dryRun,
      quiet: true,
    });

    // 4. Has resource been deleted?
    if (latestOutput === null) {
      console.log(`Resource ${resource.id} has been deleted remotely.`);
      await createResource({ resource, state, dryRun });
      continue;
    }

    // 5. Have the params of the live resource drifted from the state?
    const remoteDetailedDiff = deepDiff.detailedDiff(
      resource.toComparable(latestOutput),
      resource.toComparable(stateNode.output),
    );

    // diff to transition from live to declared state
    const remoteDiff = {
      ...remoteDetailedDiff.updated,
      ...remoteDetailedDiff.added,
    };
    const resourceHasDrifted = Object.keys(remoteDiff).length > 0;

    if (resourceHasDrifted) {
      console.log(
        `Remote ${resource.id} has drifted from its state. Reverting...`,
      );
      await updateResource({ resource, state, patch: remoteDiff, dryRun });
      continue;
    }
  }

  // 6. Has resource been removed from the orchestration graph?
  const stateNodes = (await state.values()).reverse();

  for (const stateNode of stateNodes.reverse()) {
    let resource = graph.resources.find((r) => r.id === stateNode.id);

    if (!resource) {
      const Resource = resolveResourceClass(resourceRegistry, stateNode.type);
      resource = new Resource({
        id: stateNode.id,
        config: stateNode.config,
      }) as BaseResource;
      resource.setOutput(stateNode.output);
      await deleteResource({ resource, state, dryRun });
    }
  }
}
