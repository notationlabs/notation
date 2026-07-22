import type { BaseResource } from "@notation/resource";
import type { StateBackend } from "@notation/state";
import { buildResourceDepthLevels } from "./dependency-graph";
import {
  decideAction,
  getDependencyIds,
  resolvePlanParams,
  type Plan,
  type PlanNode,
} from "./plan";

export type CreatePlanOptions = {
  resources: BaseResource[];
  state: StateBackend;
  driftDetection?: boolean;
};

export async function createPlan({
  resources,
  state,
  driftDetection = true,
}: CreatePlanOptions): Promise<Plan> {
  const resourceById = new Map(
    resources.map((resource) => [resource.id, resource]),
  );
  const nodes: PlanNode[] = [];

  for (const level of buildResourceDepthLevels(resources)) {
    for (const resource of level) {
      const stateNode = await state.get(resource.id);
      if (stateNode) resource.setOutput(stateNode.output);
      const params = await resolvePlanParams(resource);
      let action = decideAction({ resource, stateNode, params });

      if (action.decision === "noop" && driftDetection && resource.read) {
        try {
          const output = await resource.read(resource.key);
          action = decideAction({
            resource,
            stateNode,
            params,
            driftRead: { status: "found", output },
          });
        } catch (error) {
          const notFound = resource.notFoundOnError?.some(
            (matcher) => matcher.name === (error as Error)?.name,
          );
          if (!notFound) throw error;
          action = decideAction({
            resource,
            stateNode,
            params,
            driftRead: { status: "not-found" },
          });
        }
      }

      nodes.push({
        id: resource.id,
        type: resource.type,
        decision: action.decision,
        ...("diff" in action ? { diff: action.diff } : {}),
        params,
        dependsOn: getDependencyIds(resource),
      });
    }
  }

  for (const stateNode of await state.values()) {
    if (resourceById.has(stateNode.id)) continue;
    nodes.push({
      id: stateNode.id,
      type: stateNode.type,
      decision: "delete-orphan",
      params: stateNode.params,
      dependsOn: [],
    });
  }

  return { createdAt: new Date().toISOString(), nodes };
}
