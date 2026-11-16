import { randomUUID } from "node:crypto";
import {
  assertRequiredOutputs,
  containsUnknownAfterApply,
  credentialNames,
  diffParams,
  fillPhysicalNames,
  findCredentialMarkers,
  isCredentialMarker,
  isCredentialSource,
  validateParams,
  type BaseCredentialSource,
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
import {
  assertNoHiddenCredential,
  findCredentialConsumers,
  setRecordedOutput,
  takesCredential,
} from "./credentials";
import { toEmitStep, type ReconcilerEventEmitter } from "./events";
import { applyDriftDetection } from "./operations";
import { sweepSteps, sweptRecords } from "./orphan-sweep";
import {
  assertChangeAllowed,
  assertOrphanDeleteAllowed,
  decideAction,
  getDependencyIds,
  keepsResource,
  recordedEdges,
  retiredEdges,
  type Plan,
  type PlanNode,
  type ResourceAction,
  UNKNOWN_AFTER_APPLY,
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
import {
  assertNoPassedCredential,
  assertOverrides,
  instanceHash,
  findReplaceOverride,
  shortVersion,
  withStateIdentifiers,
  type Overrides,
} from "./overrides";
import { readAndDecideSource } from "./sources";
import {
  mintedCredentials,
  rotatesForCreate,
  throwIfUnobtainable,
  type UnobtainableCredential,
} from "./unobtainable-credential";
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
  /** The replaces and the credentials that the user asked for. */
  overrides?: Overrides;
  /**
   * The key of the deployment's state. With it, each node of a resource in
   * code that has a record gets its instance hash. Required with
   * `overrides`.
   */
  deploymentId?: string;
  /** The app, for the `read` of each source. */
  app: string;
  /** The stage, for the `read` of each source. */
  stage: string;
  /** The execution ID that each source's `read` receives. Defaults to a new one. */
  executionId?: string;
};

export async function createPlan({
  resources,
  state,
  driftDetection,
  emit,
  maxOperationAttempts,
  registry,
  overrides,
  deploymentId,
  app,
  stage,
  executionId = randomUUID(),
}: CreatePlanOptions): Promise<Plan> {
  const resourceById = new Map(
    resources.map((resource) => [resource.id, resource]),
  );
  const emitStep = toEmitStep(emit);
  const nodes: PlanNode[] = [];
  assertDependenciesPresent(resources);

  const stateNodes = await state.values();
  if (overrides) {
    if (deploymentId === undefined) {
      throw new Error("createPlan needs deploymentId to plan --replace.");
    }
    assertOverrides(overrides, {
      resources,
      records: stateNodes,
      deploymentId,
      point: "plan",
    });
  }
  // The overrides that each UnobtainableCredentialError gives, whose deploy
  // commands need the hashes and versions.
  const identified =
    overrides && deploymentId !== undefined
      ? withStateIdentifiers(overrides, {
          resources,
          records: stateNodes,
          deploymentId,
        })
      : overrides;
  const recordedOutputs = await readRecordedOutputs(resources, state);
  // The credentials that deploy cannot get. Plan goes on as if `--credential`
  // passed each, and fails after the last resource with all of them.
  const unobtainable: UnobtainableCredential[] = [];
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

  // As deploy does in `reconcileSource`: plan reads every source.
  const planSource = async (
    source: BaseCredentialSource,
  ): Promise<PlanNode> => {
    const { stateNode, params } = await planKnownParams(
      source,
      state,
      "plan",
      recordedOutputs,
    );
    const record =
      stateNode && !isCreatingRecord(stateNode) ? stateNode : undefined;
    const node = {
      id: source.id,
      type: source.type,
      params,
      dependsOn: getDependencyIds(source),
    };
    if (containsUnknownAfterApply(params)) {
      // The read needs every param, so the revision is unknown, and so is
      // the version of the credential.
      source.setOutput(null as any);
      if (!record) return { ...node, decision: "create" };
      const { diff } = diffParams(source.schema, record.params, params, {
        canUpdate: true,
      });
      return { ...node, decision: "update", diff };
    }
    const { decision, output, diff } = await runOperation(
      readAndDecideSource(
        createStepRunner(),
        () => emitStep,
        source,
        params,
        { id: source.id, executionId, app, stage },
        record,
      ),
    );
    source.setOutput(output);
    return { ...node, decision, ...(diff ? { diff } : {}) };
  };

  const planResource = async (
    resource: BaseResource,
    cycle: DeployUnit | undefined,
    detectDrift = driftDetection,
  ): Promise<PlanNode> => {
    if (isCredentialSource(resource)) return planSource(resource);
    const known = await planKnownParams(
      resource,
      state,
      "plan",
      recordedOutputs,
    );
    const { stateNode } = known;
    let { params } = known;
    const replaceOverride = findReplaceOverride(overrides, resource.id);
    const action: ResourceAction = await runOperation(
      applyDriftDetection(createStepRunner(), {
        action: decideAction({
          resource,
          stateNode,
          params,
          replaceOverride,
        }),
        // A requested replace creates the resource again, so a read of it
        // would change nothing.
        driftDetection: replaceOverride ? false : detectDrift,
        resource,
        resourceParams: params,
        persistedOutput: stateNode?.output,
        emit: emitStep,
        maxOperationAttempts,
      }),
    );

    // As deploy does before it reaches the resources that take a credential
    // of this one. See `mintNeededCredentials`.
    const rotates =
      stateNode &&
      !isCreatingRecord(stateNode) &&
      keepsResource(action.decision)
        ? await mintedCredentials({
            producer: resource,
            record: stateNode,
            consumers: findCredentialConsumers(resource, resources).map(
              (consumer) => ({
                resource: consumer,
                record: stateById.get(consumer.id),
              }),
            ),
            recordedOutputs,
            overrides: identified,
            deploymentId,
            unobtainable,
          })
        : [];

    const dependsOn = getDependencyIds(resource);
    const replaceFields =
      "replaceFields" in action ? action.replaceFields : undefined;
    const replacedDependency = cascaded.get(resource.id);
    const replaced = Boolean(replaceFields || replacedDependency);
    if (replaced || !keepsResource(action.decision)) {
      assertNoPassedCredential(overrides, resource);
    }
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
    if (rotates.length > 0) {
      // The new version is unknown until deploy rotates the credential, so
      // the resources that take it plan an update.
      resource.setOutput({
        ...resource.output,
        ...Object.fromEntries(
          rotates.map((name) => [name, UNKNOWN_AFTER_APPLY]),
        ),
      });
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
      ...(rotates.length > 0 ? { rotates } : {}),
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
      ...(deploymentId && stateNode && !isCreatingRecord(stateNode)
        ? { instanceHash: instanceHash(deploymentId, resource, stateNode) }
        : {}),
      ...recordedCredentialVersions(resource, stateNode),
      params,
      dependsOn,
    };
  };

  // The resources planned so far, by ID, each with its cycle.
  const planned = new Map<
    string,
    { resource: BaseResource; cycle: DeployUnit | undefined }
  >();

  // As deploy does when it reaches a resource that it creates again, and
  // that takes a credential whose value it does not hold. See
  // `obtainCredentials`. `lists` hold the nodes planned so far.
  //
  // The params of `node` hold a marker only for a credential that gets no
  // new value earlier in the deploy. Plan holds no value, as deploy holds
  // none for a credential made in an earlier deploy.
  const planLateRotations = async (node: PlanNode, lists: PlanNode[][]) => {
    if (keepsResource(node.decision)) return;
    const find = (id: string) => {
      for (const list of lists) {
        const index = list.findIndex(
          (other) => other.id === id && other.decision !== "delete-retired",
        );
        if (index >= 0) return { list, index };
      }
      return undefined;
    };
    for (const { $credential } of findCredentialMarkers(node.params)) {
      const { resource: id, name } = $credential;
      const producer = resourceById.get(id);
      const at = find(id);
      if (!producer || !at) continue;
      const producerNode = at.list[at.index]!;
      if (isCredentialSource(producer)) continue;
      if (producerNode.rotates?.includes(name)) continue;
      const rotates = rotatesForCreate({
        consumer: resourceById.get(node.id)!,
        producer,
        name,
        record: stateById.get(id),
        overrides: identified,
        deploymentId,
        unobtainable,
      });
      if (!rotates) continue;
      producerNode.rotates = [...(producerNode.rotates ?? []), name];
      producer.setOutput({ ...producer.output, [name]: UNKNOWN_AFTER_APPLY });
      // Deploy updates the resources before this one that take the
      // credential. The first plan of each read it for drift.
      for (const [siblingId, sibling] of planned) {
        if (!takesCredential(sibling.resource, producer, name)) continue;
        const siblingAt = find(siblingId);
        const first = siblingAt?.list[siblingAt.index];
        if (!first || !keepsResource(first.decision)) continue;
        const again = await planResource(
          sibling.resource,
          sibling.cycle,
          false,
        );
        // A resource with drift keeps its node, and its diff gains the
        // credential.
        siblingAt!.list[siblingAt!.index] =
          first.decision === "drift-update" && first.diff && again.diff
            ? {
                ...first,
                params: again.params,
                diff: {
                  added: { ...first.diff.added, ...again.diff.added },
                  deleted: { ...first.diff.deleted, ...again.diff.deleted },
                  updated: { ...first.diff.updated, ...again.diff.updated },
                },
              }
            : again;
      }
    }
  };

  // The records whose retired instances deploy deletes with the record, in a
  // delete-first replace or a cascade, and not at the end of the deploy.
  const deletedWithRecord = new Set<string>();
  for (const unit of orderDeployUnits(resources)) {
    const cycle = isCycle(unit) ? unit : undefined;
    const members = await loadUnit(unit, state);
    const unitNodes: PlanNode[] = [];
    for (const resource of members) {
      const node = await planResource(resource, cycle);
      unitNodes.push(node);
      await planLateRotations(node, [unitNodes, nodes]);
      planned.set(resource.id, { resource, cycle });
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
  throwIfUnobtainable(unobtainable, identified);

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

function recordedCredentialVersions(
  resource: BaseResource,
  stateNode: StateNode | undefined,
): { credentialVersions?: Record<string, string> } {
  if (
    !stateNode ||
    isCreatingRecord(stateNode) ||
    isCredentialSource(resource)
  ) {
    return {};
  }
  const versions: Record<string, string> = {};
  for (const name of credentialNames(resource.schema)) {
    const marker = stateNode.output[name];
    if (isCredentialMarker(marker) && marker.$credential.version !== null) {
      versions[name] = shortVersion(marker.$credential.version);
    }
  }
  return Object.keys(versions).length > 0
    ? { credentialVersions: versions }
    : {};
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
    setRecordedOutput(resource, stateNode.output);
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
  assertNoHiddenCredential(resource);
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
