import type { BaseResource } from "@notation/resource";
import type { StateBackend } from "@notation/state";
import { buildResourceDepthLevels } from "./dependency-graph";
import { toEmitStep, type ReconcilerEventEmitter } from "./events";
import { readDriftOperation } from "./operations";
import {
  decideAction,
  decideDriftAction,
  getDependencyIds,
  resolvePlanParams,
  type Plan,
  type PlanNode,
} from "./plan";
import { createStepRunner, runOperation } from "./step-runner";

/** Planning only reads state. */
export type PlannerState = Pick<StateBackend, "get" | "values">;

export type CreatePlanOptions = {
  resources: BaseResource[];
  state: PlannerState;
  driftDetection?: boolean;
  emit?: ReconcilerEventEmitter;
  maxOperationAttempts?: number;
};

export async function createPlan({
  resources,
  state,
  driftDetection = true,
  emit,
  maxOperationAttempts,
}: CreatePlanOptions): Promise<Plan> {
  const resourceById = new Map(
    resources.map((resource) => [resource.id, resource]),
  );
  const emitStep = emit ? toEmitStep(emit) : undefined;
  const nodes: PlanNode[] = [];

  for (const level of buildResourceDepthLevels(resources)) {
    for (const resource of level) {
      const stateNode = await state.get(resource.id);
      if (stateNode) resource.setOutput(stateNode.output);
      const params = await resolvePlanParams(resource);
      let action = decideAction({ resource, stateNode, params });

      if (action.decision === "noop" && driftDetection && resource.read) {
        const driftRead = await runOperation(
          readDriftOperation(createStepRunner(), {
            resource,
            resourceParams: params,
            persistedOutput: stateNode?.output,
            emit: emitStep,
            maxOperationAttempts,
          }),
        );

        action = decideDriftAction({ resource, params, driftRead });
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
