import type { BaseResource } from "@notation/resource";
import type { StateBackend } from "@notation/state";
import { buildResourceDepthLevels } from "./dependency-graph";
import { toEmitStep, type ReconcilerEventEmitter } from "./events";
import { applyDriftDetection } from "./operations";
import {
  decideAction,
  getDependencyIds,
  resolvePlanParams,
  type Plan,
  type PlanNode,
} from "./plan";
import { createStepRunner, runOperation } from "./step-runner";

export type CreatePlanOptions = {
  resources: BaseResource[];
  state: StateBackend;
  driftDetection?: boolean;
  emit?: ReconcilerEventEmitter;
  maxOperationAttempts?: number;
};

export async function createPlan({
  resources,
  state,
  driftDetection,
  emit,
  maxOperationAttempts,
}: CreatePlanOptions): Promise<Plan> {
  const resourceById = new Map(
    resources.map((resource) => [resource.id, resource]),
  );
  const emitStep = toEmitStep(emit);
  const nodes: PlanNode[] = [];

  for (const level of buildResourceDepthLevels(resources)) {
    for (const resource of level) {
      const stateNode = await state.get(resource.id);
      if (stateNode) resource.setOutput(stateNode.output);
      const params = await resolvePlanParams(resource);
      const action = await runOperation(
        applyDriftDetection(createStepRunner(), {
          action: decideAction({ resource, stateNode, params }),
          driftDetection,
          resource,
          resourceParams: params,
          persistedOutput: stateNode?.output,
          emit: emitStep,
          maxOperationAttempts,
        }),
      );

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
