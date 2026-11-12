import {
  assertRequiredOutputs,
  validateParams,
  type BaseResource,
} from "@notation/resource";
import type { StateBackend, StateNode } from "@notation/state";
import {
  assertDependenciesPresent,
  buildResourceDepthLevels,
  collectDependents,
} from "./dependency-graph";
import { createBlocksDelete } from "./delete-cascade";
import { toEmitStep, type ReconcilerEventEmitter } from "./events";
import { applyDriftDetection } from "./operations";
import {
  decideAction,
  getDependencyIds,
  recordedEdges,
  type Plan,
  type PlanNode,
} from "./plan";
import { workflowRegistry, type ResourceRegistry } from "./resource-registry";
import { assertSameType } from "./resource-type";
import { createStepRunner, runOperation } from "./step-runner";

/**
 * Added to the error for a required output missing from the state record of
 * a resource with no `read`.
 */
export const NO_READ_MISSING_OUTPUTS_HINT =
  "The resource's type has no read, so deploy can't fill them in. Remove the resource from the code, deploy, then add it back, so that it is created again.";

export type CreatePlanOptions = {
  resources: BaseResource[];
  state: StateBackend;
  driftDetection?: boolean;
  emit?: ReconcilerEventEmitter;
  maxOperationAttempts?: number;
  /** As for deploy: the classes of the types that only orphans have. */
  registry?: ResourceRegistry;
};

export async function createPlan({
  resources,
  state,
  driftDetection,
  emit,
  maxOperationAttempts,
  registry,
}: CreatePlanOptions): Promise<Plan> {
  const resourceById = new Map(
    resources.map((resource) => [resource.id, resource]),
  );
  const emitStep = toEmitStep(emit);
  const nodes: PlanNode[] = [];
  assertDependenciesPresent(resources);

  const stateNodes = await state.values();
  // The edges in state as deploy finds them when it replaces a resource.
  // Deploy writes the edges in code for each resource it reaches, so a
  // resource takes those once it is planned.
  const edgesById = new Map(
    stateNodes.map((node) => [node.id, recordedEdges(node, resourceById)]),
  );
  const blocksDelete = createBlocksDelete(
    stateNodes,
    workflowRegistry({ resources, registry }),
  );
  // The resources that deploy deletes before a replaced resource, by ID, with
  // the ID of the replaced resource.
  const cascaded = new Map<string, string>();

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

      const dependsOn = getDependencyIds(resource);
      const replaceFields =
        "replaceFields" in action ? action.replaceFields : undefined;
      const replacedDependency = cascaded.get(resource.id);
      const replaced = Boolean(replaceFields || replacedDependency);

      // Plan treats a required output missing from a resource's state as
      // unknown, because deploy reads the resource again to fill it in. A
      // resource with no `read` cannot be read again, and an update keeps only
      // its params as output. A replace creates the resource again, and the
      // create writes the output. A replace that is only possible, because a
      // field that forces it is unknown, passes too. Deploy fails if it ends
      // up a noop or an update.
      if (stateNode && !resource.read && !replaced) {
        assertRequiredOutputs(
          resource,
          stateNode.output,
          NO_READ_MISSING_OUTPUTS_HINT,
        );
      }

      if (replaceFields) {
        for (const id of collectDependents(
          resource.id,
          edgesById,
          blocksDelete,
        )) {
          cascaded.set(id, resource.id);
          edgesById.delete(id);
        }
      }

      if (replaced) {
        // A replacement's output is unknown until it has been created again,
        // so its dependents plan against unknown params, as they would for a
        // resource with no state.
        resource.setOutput(null as any);
      }
      edgesById.set(resource.id, dependsOn);

      // A resource deleted in a cascade is created again, so a diff of an
      // update does not apply to it.
      const cascadeOnly = replacedDependency && !replaceFields;
      nodes.push({
        id: resource.id,
        type: resource.type,
        decision: cascadeOnly ? "replace" : action.decision,
        ...("diff" in action && !cascadeOnly ? { diff: action.diff } : {}),
        ...(replaceFields ? { replaceFields } : {}),
        ...(replacedDependency ? { replacedDependency } : {}),
        params,
        dependsOn,
      });
    }
  }

  for (const stateNode of stateNodes) {
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
 * params that plan knows. Throws if the state record has a different type.
 * Outputs in state stand in for the outputs of dependencies, so the
 * dependencies must be loaded first.
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
  assertSameType(resource, stateNode);
  if (stateNode) resource.setOutput(stateNode.output);
  const params = await resource.planParams();
  await validateParams(resource, params, point);
  return { stateNode, params };
}
