import {
  assertRequiredOutputs,
  fillPhysicalNames,
  validateParams,
  type BaseResource,
  type RecordedOutputs,
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
import { sweepSteps, sweptRecords } from "./orphan-sweep";
import {
  assertChangeAllowed,
  assertOrphanDeleteAllowed,
  decideAction,
  getDependencyIds,
  recordedEdges,
  retiredEdges,
  type Plan,
  type PlanNode,
} from "./plan";
import { workflowRegistry, type ResourceRegistry } from "./resource-registry";
import {
  assertNamesNotSupplied,
  recordedNames,
  nameFields,
  replaceOrder,
  unknownNames,
} from "./physical-names";
import { readRecordedOutputs } from "./recorded-outputs";
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
  const recordedOutputs = await readRecordedOutputs(resources, state);
  // The edges in state as deploy finds them when it replaces a resource.
  // Deploy writes the edges in code for each resource it reaches, so a
  // resource takes those once it is planned.
  const edgesById = new Map(
    stateNodes.map((node) => [node.id, recordedEdges(node, resourceById)]),
  );
  // The edges of the retired instances that each record lists, as deploy
  // finds them. A retired instance that depends on a resource blocks its
  // delete as the record does.
  const retiredEdgesById = new Map(
    stateNodes.map((node) => [node.id, retiredEdges(node)]),
  );
  const stateById = new Map(stateNodes.map((node) => [node.id, node]));
  const classes = workflowRegistry({ resources, registry });
  const blocksDelete = createBlocksDelete(stateNodes, classes);
  // The resources that deploy deletes before a replaced resource, by ID, with
  // the ID of the replaced resource.
  const cascaded = new Map<string, string>();

  const planResource = async (
    resource: BaseResource,
    cycle: DeployUnit | undefined,
    detectDrift = driftDetection,
  ): Promise<PlanNode> => {
    const known = await planKnownParams(
      resource,
      state,
      "plan",
      recordedOutputs,
    );
    const { stateNode } = known;
    let { params } = known;
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
    // A resource deleted in a cascade is deleted before it is created again,
    // whatever its class.
    const order = replacedDependency ? "delete-first" : replaceOrder(resource);

    // A resource with no `read` can't recover a missing output, and update
    // doesn't write one. A replace, including one that is only possible,
    // creates the resource again. Deploy checks again once the decision is
    // known.
    if (!replaced) assertOutputsRecoverable(resource, stateNode);

    // A create-first replace deletes no dependent in advance.
    if (replaceFields && order === "delete-first") {
      const cascadeEdges = new Map(
        [...edgesById].map(([id, edges]) => [
          id,
          [...edges, ...(retiredEdgesById.get(id) ?? [])],
        ]),
      );
      for (const id of collectDependents(
        resource.id,
        cascadeEdges,
        blocksDelete,
      )) {
        cascaded.set(id, resource.id);
        edgesById.delete(id);
        retiredEdgesById.delete(id);
      }
    }

    // As deploy lists them for the delete: by the edges in state for a
    // resource it has not reached, and by the edges in code for one it has.
    // A create-first replace deletes the resource after deploy has moved its
    // dependents in code to the replacement.
    const brokenDependents =
      replaceFields &&
      order === "delete-first" &&
      resource.deleteTakesDependents
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
      params = fillPhysicalNames(known.unnamed, unknownNames(resource));
    }
    edgesById.set(resource.id, dependsOn);
    // A delete-first replace deletes the retired instances, and a create-first
    // replace retires the resource.
    if (replaced && order === "delete-first") {
      retiredEdgesById.delete(resource.id);
    }
    if (replaced && order === "create-first") {
      retiredEdgesById.set(resource.id, [
        ...retiredEdges(stateNode),
        ...(stateNode?.dependsOn ?? dependsOn),
      ]);
    }

    // A resource deleted in a cascade is created again, so a diff of an
    // update does not apply to it.
    const cascadeOnly = replacedDependency && !replaceFields;
    if (cascadeOnly && stateNode) {
      assertChangeAllowed(
        resource.id,
        resource.rejectChange,
        stateNode.params,
        params,
        { replace: true },
      );
    }
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
      ...(replaced ? { replaceOrder: order } : {}),
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

  // The records whose retired instances deploy deletes with the record, in a
  // delete-first replace or a cascade, and not at the end of the deploy.
  const deletedWithRecord = new Set<string>();
  for (const unit of orderDeployUnits(resources)) {
    const cycle = isCycle(unit) ? unit : undefined;
    const members = await loadUnit(unit, state);
    const unitNodes: PlanNode[] = [];
    for (const resource of members) {
      unitNodes.push(await planResource(resource, cycle));
    }
    if (cycle) {
      // A member planned before a replaced member took the output of the old
      // resource from state. Deploy updates it with the unknown output of the
      // replacement once it is created, so it is planned again. The first
      // plan read it for drift, so the second plan doesn't, and a member with
      // drift keeps its first node.
      const isReplaced = (node: PlanNode) =>
        node.decision === "replace" || node.decision === "drift-replace";
      const last = unitNodes.findLastIndex(isReplaced);
      for (let index = 0; index < last; index += 1) {
        const node = unitNodes[index]!;
        if (node.decision !== "noop" && node.decision !== "update") continue;
        unitNodes[index] = await planResource(members[index]!, cycle, false);
      }
    }
    for (const node of unitNodes) {
      if (node.replaceOrder === "delete-first") {
        deletedWithRecord.add(node.id);
        nodes.push(...retiredNodes(stateById.get(node.id)));
      }
      nodes.push(node);
    }
  }

  const inCode = new Set(resourceById.keys());
  const { swept, edgesById: sweptEdges } = sweptRecords(stateNodes, inCode);
  const steps = sweepSteps(swept, classes, sweptEdges, new Set());
  for (const { node, orphan, Resource } of steps) {
    if (orphan && Resource) assertOrphanDeleteAllowed(classes, node);
  }
  // The retired instances and the orphans, in the order of the sweep. An
  // orphan that the sweep keeps is still planned as a delete, after them.
  const plannedOrphans = new Set<string>();
  const pushOrphan = (stateNode: StateNode) => {
    plannedOrphans.add(stateNode.id);
    nodes.push({
      id: stateNode.id,
      type: stateNode.type,
      decision: "delete-orphan",
      params: stateNode.params,
      dependsOn: stateNode.dependsOn ?? [],
    });
  };
  for (const { node, orphan, Resource } of steps) {
    if (Resource && !deletedWithRecord.has(node.id)) {
      nodes.push(...retiredNodes(node));
    }
    if (orphan) pushOrphan(node);
  }
  for (const stateNode of stateNodes) {
    if (!inCode.has(stateNode.id) && !plannedOrphans.has(stateNode.id)) {
      pushOrphan(stateNode);
    }
  }

  return { createdAt: new Date().toISOString(), nodes };
}

/** A `delete-retired` node for each retired instance that `node` lists. */
function retiredNodes(node: StateNode | undefined): PlanNode[] {
  return (node?.retired ?? []).map((instance, index) => ({
    id: node!.id,
    type: node!.type,
    decision: "delete-retired",
    retiredIndex: index,
    retiredAt: instance.retiredAt,
    params: instance.params,
    dependsOn: instance.dependsOn,
  }));
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
 * A `physicalName` param takes its value from the state record, as in
 * deploy, and so does a ref to it from another of the resource's params.
 * Without a record, deploy generates the name, so it is unknown here.
 * `unnamed` holds the params before the names are filled in.
 */
export async function planKnownParams(
  resource: BaseResource,
  state: { get(id: string): Promise<StateNode | undefined> },
  point: "plan" | "deploy",
  recordedOutputs: RecordedOutputs,
): Promise<{
  stateNode: StateNode | undefined;
  params: Record<string, unknown>;
  unnamed: Record<string, unknown>;
}> {
  const stateNode = await loadOutput(resource, state);
  const names = nameFields(resource);
  const unnamed = await resource.planParams({ recordedOutputs });
  assertNamesNotSupplied(resource, names, unnamed);
  const params = fillPhysicalNames(unnamed, {
    ...unknownNames(resource),
    ...recordedNames(names, stateNode),
  });
  await validateParams(resource, params, point);
  return { stateNode, params, unnamed };
}
