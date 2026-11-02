import { validateParams, type BaseResource } from "@notation/resource";
import type { StateBackend, StateNode } from "@notation/state";
import {
  assertDependenciesPresent,
  buildResourceDepthLevels,
} from "./dependency-graph";
import { toEmitStep, type ReconcilerEventEmitter } from "./events";
import { applyDriftDetection } from "./operations";
import {
  decideAction,
  getDependencyIds,
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
  assertDependenciesPresent(resources);

  for (const level of buildResourceDepthLevels(resources)) {
    for (const resource of level) {
      const { stateNode, params } = await planKnownParams(
        resource,
        state,
        "plan",
      );
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

      // A replacement's output is unknown until it has been created again,
      // so its dependents plan against unknown params, as they would for a
      // resource with no state.
      if ("replaceFields" in action) resource.setOutput(null as any);

      nodes.push({
        id: resource.id,
        type: resource.type,
        decision: action.decision,
        ...("diff" in action ? { diff: action.diff } : {}),
        ...("replaceFields" in action
          ? { replaceFields: action.replaceFields }
          : {}),
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
      dependsOn: stateNode.dependsOn ?? [],
    });
  }

  return { createdAt: new Date().toISOString(), nodes };
}

/**
 * Loads the resource's outputs from state, then returns and checks the
 * params that plan knows. Outputs in state stand in for the outputs of
 * dependencies, so the dependencies must be loaded first.
 */
export async function planKnownParams(
  resource: BaseResource,
  state: { get(id: string): Promise<StateNode | undefined> },
  point: "plan" | "deploy",
): Promise<{
  stateNode: StateNode | undefined;
  params: Record<string, unknown>;
}> {
  const stateNode = await state.get(resource.id);
  if (stateNode) resource.setOutput(stateNode.output);
  const params = await resource.planParams();
  await validateParams(resource, params, point);
  return { stateNode, params };
}
