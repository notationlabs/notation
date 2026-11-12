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
  const cascade = createReplaceCascade({ resources, stateNodes, registry });

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
      const replacedDependency = cascade.replacedDependency(resource.id);
      assertOutputsRecoverable(
        resource,
        stateNode,
        Boolean(replaceFields || replacedDependency),
      );
      cascade.add(resource, Boolean(replaceFields));

      if (replaceFields || replacedDependency) {
        // A replacement's output is unknown until it has been created again,
        // so its dependents plan against unknown params, as they would for a
        // resource with no state.
        resource.setOutput(null as any);
      }

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
 * Follows the resources that deploy deletes before a replaced resource, as
 * deploy finds them. Add each resource in dependency order, after its
 * decision.
 */
export function createReplaceCascade(opts: {
  resources: BaseResource[];
  stateNodes: StateNode[];
  registry?: ResourceRegistry;
}) {
  const resourceById = new Map(
    opts.resources.map((resource) => [resource.id, resource]),
  );
  // The edges in state as deploy finds them when it replaces a resource.
  // Deploy writes the edges in code for each resource it reaches, so a
  // resource takes those once it is added.
  const edgesById = new Map(
    opts.stateNodes.map((node) => [node.id, recordedEdges(node, resourceById)]),
  );
  const blocksDelete = createBlocksDelete(
    opts.stateNodes,
    workflowRegistry({ resources: opts.resources, registry: opts.registry }),
  );
  // The ID of each resource that deploy deletes in a cascade, with the ID of
  // the replaced resource.
  const cascaded = new Map<string, string>();

  return {
    /** The ID of the replaced resource that deploy deletes this one before. */
    replacedDependency(id: string): string | undefined {
      return cascaded.get(id);
    },
    add(resource: BaseResource, replaced: boolean): void {
      if (replaced) {
        for (const id of collectDependents(
          resource.id,
          edgesById,
          blocksDelete,
        )) {
          cascaded.set(id, resource.id);
          edgesById.delete(id);
        }
      }
      edgesById.set(resource.id, getDependencyIds(resource));
    },
  };
}

/**
 * Throws if a resource with no `read` lacks a required output in state and
 * deploy does not replace it. Plan treats a required output missing from a
 * resource's state as unknown, because deploy reads the resource again to
 * fill it in. A resource with no `read` cannot be read again. Update can't
 * fill in an output either, because deploy keeps only the update's params as
 * output. A replace deletes the resource and creates it again, and the create
 * writes the output.
 */
export function assertOutputsRecoverable(
  resource: BaseResource,
  stateNode: StateNode | undefined,
  replaced: boolean,
): void {
  if (!stateNode || resource.read || replaced) return;
  assertRequiredOutputs(
    resource,
    stateNode.output,
    "The resource's type has no read, so deploy can't fill them in. Remove the resource from the code, deploy, then add it back, so that it is created again.",
  );
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
