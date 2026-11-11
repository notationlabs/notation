import {
  assertRequiredOutputs,
  validateParams,
  type BaseResource,
} from "@notation/resource";
import type { StateBackend, StateNode } from "@notation/state";
import {
  assertDependenciesPresent,
  collectDependents,
} from "./dependency-graph";
import { orderDeployUnits, type DeployUnit } from "./cycles";
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

  for (const unit of orderDeployUnits(resources)) {
    const cycle = unit.kind === "cycle" ? unit.cycle : undefined;
    for (const resource of await loadUnit(unit, state)) {
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

      if (replaceFields || replacedDependency) {
        // A replacement's output is unknown until it has been created again,
        // so its dependents plan against unknown params, as they would for a
        // resource with no state.
        resource.setOutput(null as any);
      }
      edgesById.set(resource.id, dependsOn);

      // A resource deleted in a cascade is created again, so a diff of an
      // update does not apply to it.
      const cascadeOnly = replacedDependency && !replaceFields;
      const placeholder =
        cycle?.placeholders.includes(resource) && action.decision === "create";
      nodes.push({
        id: resource.id,
        type: resource.type,
        decision: cascadeOnly ? "replace" : action.decision,
        ...("diff" in action && !cascadeOnly ? { diff: action.diff } : {}),
        ...(replaceFields ? { replaceFields } : {}),
        ...(replacedDependency ? { replacedDependency } : {}),
        ...(cycle
          ? {
              cycle: cycle.members
                .filter((member) => member !== resource)
                .map((member) => member.id),
            }
          : {}),
        ...(placeholder ? { placeholder: true as const } : {}),
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
 * Returns the resources of a unit in order. For a cycle, it first loads the
 * output of every member from state, as a member can depend on a member
 * that comes after it.
 */
export async function loadUnit(
  unit: DeployUnit,
  state: { get(id: string): Promise<StateNode | undefined> },
): Promise<BaseResource[]> {
  if (unit.kind === "resource") return [unit.resource];
  for (const member of unit.cycle.members) {
    const stateNode = await state.get(member.id);
    assertSameType(member, stateNode);
    if (stateNode) member.setOutput(stateNode.output);
  }
  return unit.cycle.members;
}

/**
 * Loads the resource's outputs from state, then returns and checks the
 * params that plan knows. Throws if the state record has a different type.
 * Outputs in state stand in for the outputs of dependencies, so the
 * dependencies must be loaded first. Throws if a resource with no `read` lacks
 * a required output in state.
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
  // Plan treats a required output missing from a resource's state as unknown,
  // because deploy reads the resource again to fill it in. A resource with no
  // `read` cannot be read again. Update can't fill in an output either,
  // because deploy keeps only the update's params as output. The check runs
  // even when this deploy replaces the resource, though the create would
  // write a missing output that is part of its key.
  if (stateNode && !resource.read) {
    assertRequiredOutputs(
      resource,
      stateNode.output,
      "The resource's type has no read, so deploy can't fill them in. Remove the resource from the code, deploy, then add it back, so that it is created again.",
    );
  }
  const params = await resource.planParams();
  await validateParams(resource, params, point);
  return { stateNode, params };
}
