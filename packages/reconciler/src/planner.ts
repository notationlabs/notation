import {
  UNKNOWN_AFTER_APPLY,
  assertRequiredOutputs,
  validateParams,
  type BaseResource,
} from "@notation/resource";
import {
  isCreatingRecord,
  type StateBackend,
  type StateNode,
} from "@notation/state";
import {
  assertDependenciesPresent,
  collectDependents,
} from "./dependency-graph";
import { isCycle, orderDeployUnits, type DeployUnit } from "./cycles";
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
import {
  assertNamesNotDerived,
  recordedNames,
  unnamedFields,
} from "./physical-names";
import { assertSameType } from "./resource-type";
import { createStepRunner, runOperation } from "./step-runner";

/**
 * Throws if a resource with no `read` lacks a required output in its state
 * record. Does nothing for a resource with no record, a "creating" record, or
 * a `read`.
 */
export function assertOutputsRecoverable(
  resource: BaseResource,
  stateNode: StateNode | undefined,
): void {
  if (!stateNode || isCreatingRecord(stateNode) || resource.read) return;
  assertRequiredOutputs(
    resource,
    stateNode.output,
    "The resource's type has no read, so deploy can't fill them in. Remove the resource from the code, deploy, then add it back, so that it is created again.",
  );
}

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

  const planResource = async (
    resource: BaseResource,
    cycle: DeployUnit | undefined,
    detectDrift = driftDetection,
  ): Promise<PlanNode> => {
    const { stateNode, params } = await planKnownParams(
      resource,
      state,
      "plan",
    );
    const action = await runOperation(
      applyDriftDetection(createStepRunner(), {
        action: decideAction({ resource, stateNode, params }),
        driftDetection: detectDrift,
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

    // A resource with no `read` can't recover a missing output, and update
    // doesn't write one. A replace, including one that is only possible,
    // creates the resource again. Deploy checks again once the decision is
    // known.
    if (!replaced) assertOutputsRecoverable(resource, stateNode);

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

    // As deploy lists them for the delete: by the edges in state for a
    // resource it has not reached, and by the edges in code for one it has.
    const brokenDependents =
      replaceFields && resource.deleteTakesDependents
        ? [...edgesById]
            .filter(
              ([id, edges]) =>
                id !== resource.id &&
                resourceById.has(id) &&
                edges.includes(resource.id),
            )
            .map(([id]) => id)
            .sort()
        : [];

    if (replaced) {
      // A replacement's output is unknown until it has been created again,
      // so its dependents plan against unknown params, as they would for a
      // resource with no state.
      resource.setOutput(null as any);
      // Deploy generates a new name for the resource that it creates again.
      for (const { field } of unnamedFields(resource)) {
        params[field] = UNKNOWN_AFTER_APPLY;
      }
    }
    edgesById.set(resource.id, dependsOn);

    // A resource deleted in a cascade is created again, so a diff of an
    // update does not apply to it.
    const cascadeOnly = replacedDependency && !replaceFields;
    const placeholder =
      cycle?.placeholders.includes(resource) &&
      (action.decision === "create" || action.decision === "drift-recreate");
    const decision = cascadeOnly ? "replace" : action.decision;
    return {
      id: resource.id,
      type: resource.type,
      decision,
      ...("diff" in action && !cascadeOnly ? { diff: action.diff } : {}),
      ...(replaceFields ? { replaceFields } : {}),
      ...(replacedDependency ? { replacedDependency } : {}),
      ...(brokenDependents.length > 0 ? { brokenDependents } : {}),
      ...(cycle
        ? {
            cycle: cycle.members
              .filter((member) => member !== resource)
              .map((member) => member.id),
          }
        : {}),
      ...(placeholder ? { placeholder: true as const } : {}),
      ...(decision === "create" && isCreatingRecord(stateNode)
        ? { mayTakeOver: true as const }
        : {}),
      params,
      dependsOn,
    };
  };

  for (const unit of orderDeployUnits(resources)) {
    const cycle = isCycle(unit) ? unit : undefined;
    const members = await loadUnit(unit, state);
    const start = nodes.length;
    for (const resource of members) {
      nodes.push(await planResource(resource, cycle));
    }
    if (!cycle) continue;
    // A member planned before a replaced member took the output of the old
    // resource from state. Deploy updates it with the unknown output of the
    // replacement once it is created, so it is planned again. The first plan
    // read it for drift, so the second plan doesn't, and a member with drift
    // keeps its first node.
    const isReplaced = (node: PlanNode) =>
      node.decision === "replace" || node.decision === "drift-replace";
    const last = nodes.slice(start).findLastIndex(isReplaced);
    for (let index = 0; index < last; index += 1) {
      const node = nodes[start + index]!;
      if (node.decision !== "noop" && node.decision !== "update") continue;
      nodes[start + index] = await planResource(members[index]!, cycle, false);
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
  if (isCycle(unit)) {
    for (const member of unit.members) await loadOutput(member, state);
  }
  return unit.members;
}

/**
 * Loads the resource's output from its state record, and returns the
 * record. Throws if the record has a different type.
 */
async function loadOutput(
  resource: BaseResource,
  state: { get(id: string): Promise<StateNode | undefined> },
): Promise<StateNode | undefined> {
  const stateNode = await state.get(resource.id);
  assertSameType(resource, stateNode);
  // A "creating" record holds no outputs, so dependents plan against unknown
  // outputs, as for a resource with no record.
  if (stateNode && !isCreatingRecord(stateNode)) {
    resource.setOutput(stateNode.output);
  }
  return stateNode;
}

/**
 * Loads the resource's outputs from state, then returns and checks the
 * params that plan knows. Throws if the state record has a different type.
 * Outputs in state stand in for the outputs of dependencies, so the
 * dependencies must be loaded first.
 *
 * A `physicalName` param that config leaves out takes its value from the
 * state record, as in deploy. Without one, deploy generates the name, so it
 * is unknown here.
 */
export async function planKnownParams(
  resource: BaseResource,
  state: { get(id: string): Promise<StateNode | undefined> },
  point: "plan" | "deploy",
): Promise<{
  stateNode: StateNode | undefined;
  params: Record<string, unknown>;
}> {
  const stateNode = await loadOutput(resource, state);
  const unnamed = unnamedFields(resource);
  const planned = await resource.planParams();
  assertNamesNotDerived(resource, unnamed, planned);
  const params = {
    ...planned,
    ...Object.fromEntries(
      unnamed.map(({ field }) => [field, UNKNOWN_AFTER_APPLY]),
    ),
    ...recordedNames(unnamed, stateNode),
  };
  await validateParams(resource, params, point);
  return { stateNode, params };
}
