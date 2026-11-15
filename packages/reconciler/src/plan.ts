import {
  diffParams,
  type BaseResource,
  type ParamReplaceField,
  type ParamsDiffDisplay,
  type RejectChange,
  type RejectChangeContext,
  type ReplaceField,
  type ResourceType,
} from "@notation/resource";
import { isCreatingRecord, type StateNode } from "@notation/state";
import type { ReplaceOrder } from "./events";
import type { RequestedReplace } from "./replace-request";
import {
  resolveResourceClass,
  type ResourceRegistry,
} from "./resource-registry";

export {
  UNKNOWN_AFTER_APPLY,
  type ReplaceField,
  type UnknownAfterApply,
} from "@notation/resource";

export type PlanDecision =
  | "create"
  | "update"
  | "replace"
  | "drift-update"
  | "drift-replace"
  | "drift-recreate"
  | "delete-orphan"
  | "delete-retired"
  | "noop";

/** Whether the decision leaves the resource in place, and so its credentials. */
export function keepsResource(decision: PlanDecision): boolean {
  return (
    decision === "noop" || decision === "update" || decision === "drift-update"
  );
}

export type PlanDiff = ParamsDiffDisplay;

export type PlanNode = {
  id: string;
  type: string;
  decision: PlanDecision;
  diff?: PlanDiff;
  replaceFields?: ReplaceField[];
  /**
   * Set with the decisions `replace` and `drift-replace`: whether deploy
   * creates the replacement before it deletes the resource, or deletes the
   * resource first. A resource with a `physicalName` param creates first,
   * unless deploy deletes it because it blocks the delete of a dependency,
   * as `replacedDependency` says.
   */
  replaceOrder?: ReplaceOrder;
  /**
   * Set with the decision `delete-retired`, for an instance of the resource
   * that an earlier create-first replace retired: when that replace started.
   * The node has the ID of the resource, and the params and edges of the
   * instance. Deploy deletes it in the sweep at the end of the deploy, or
   * with the resource when it replaces the resource delete-first.
   */
  retiredAt?: string;
  /**
   * Set with the decision `delete-retired`: the position of the instance in
   * its record's list of retired instances, oldest first. With `id`, it
   * names the instance.
   */
  retiredIndex?: number;
  /**
   * Set when deploy deletes this resource before it replaces a resource this
   * one depends on, directly or through other deleted resources, because
   * this resource blocks that delete. Deploy then creates it again, so it is
   * replaced too. The ID of the replaced resource, as in the delete event's
   * `replacedDependency`.
   */
  replacedDependency?: string;
  /**
   * Set when deploy replaces the resource delete-first and passes
   * dependents to its delete (`deleteTakesDependents`): the IDs of the
   * declared resources whose records depend on it and that deploy does not
   * delete first. The delete
   * can break their references to it, which stay broken until deploy updates
   * each of them.
   */
  brokenDependents?: string[];
  /**
   * Set when deploy rotates credentials of the resource, because a resource
   * that takes one needs its value: the names of the credentials. Deploy
   * updates every resource that takes one of them.
   */
  rotates?: string[];
  /**
   * Set when deploy fails at this resource: it creates the resource again,
   * the resource takes these credentials, deploy holds no value for them,
   * and they have no `rotate` operation. The deploy after it replaces the
   * resources that have the credentials.
   */
  unheldCredentials?: { resource: string; name: string }[];
  /**
   * Set when the resource is in a dependency cycle: the IDs of the other
   * resources in the cycle.
   */
  cycle?: string[];
  /**
   * Set when deploy creates the resource first without its contributions,
   * and updates it with them once the rest of its cycle exists.
   */
  placeholder?: true;
  /**
   * Set for a create of a resource that has a "creating" record. An earlier
   * deploy did not finish the create, so if the resource exists, deploy
   * takes it over.
   */
  mayTakeOver?: true;
  /**
   * Set for a resource in code that has a record: the hash that
   * `--replace <id>@<instance hash>` takes. See `instanceHash`.
   */
  instanceHash?: string;
  params: Record<string, unknown>;
  dependsOn: string[];
};

export type Plan = {
  createdAt: string;
  nodes: PlanNode[];
};

export type DriftRead =
  { kind: "present"; output: Record<string, unknown> } | { kind: "absent" };

export type ResourceAction =
  | { decision: "create" }
  | { decision: "noop" }
  | { decision: "drift-recreate" }
  | { decision: "update"; patch: Record<string, unknown>; diff: PlanDiff }
  | {
      decision: "drift-update";
      patch: Record<string, unknown>;
      diff: PlanDiff;
    }
  | {
      decision: "replace";
      patch: Record<string, unknown>;
      diff: PlanDiff;
      replaceFields: ReplaceField[];
    }
  | {
      decision: "drift-replace";
      patch: Record<string, unknown>;
      diff: PlanDiff;
      replaceFields: ReplaceField[];
    };

/**
 * Decides what deploy does with the resource. With `requested`, a resource
 * that has a record is replaced, with the replace field `{ requested: true }`.
 */
export function decideAction(opts: {
  resource: BaseResource;
  stateNode?: StateNode;
  params: Record<string, unknown>;
  requested?: RequestedReplace;
}): ResourceAction {
  const { resource, stateNode, params, requested } = opts;
  // A create that left a "creating" record may or may not have made the
  // resource. Create runs again, and takes the resource over if the provider
  // reports that it already exists.
  if (!stateNode || isCreatingRecord(stateNode)) {
    return { decision: "create" };
  }

  const { patch, diff, replaceFields } = diffParams(
    resource.schema,
    stateNode.params,
    params,
    { canUpdate: Boolean(resource.update) },
  );
  // Before `rejectChange`, so that a requested replace that also changes a
  // param fails with the param's own message.
  if (replaceFields.length > 0) {
    assertReplaceAllowed(resource, stateNode.params, params, replaceFields);
  }
  if (!requested?.overrideLossProtection) {
    assertChangeAllowed(
      resource.id,
      resource.rejectChange,
      stateNode.params,
      params,
      {
        replace: Boolean(requested) || replaceFields.length > 0,
        ...(requested ? { requested: true as const } : {}),
      },
      requested
        ? `To replace it, pass --override-loss-protection ${resource.id} with --replace.`
        : undefined,
    );
  }

  if (requested || replaceFields.length > 0) {
    return {
      decision: "replace",
      patch,
      diff,
      replaceFields: requested
        ? [...replaceFields, { requested: true, known: true }]
        : replaceFields,
    };
  }
  if (Object.keys(patch).length > 0) {
    return { decision: "update", patch, diff };
  }

  return { decision: "noop" };
}

/**
 * Throws if a changed param has `rejectReplace`. A value that is unknown
 * until apply is skipped, and checked again at deploy with the real value.
 */
function assertReplaceAllowed(
  resource: BaseResource,
  previous: Record<string, unknown>,
  desired: Record<string, unknown>,
  replaceFields: ParamReplaceField[],
): void {
  for (const { name, known } of replaceFields) {
    const item = resource.schema[name];
    if (!known || item?.propertyType !== "param" || !item.rejectReplace) {
      continue;
    }
    throw new Error(
      `${resource.id}: ${item.rejectReplace(previous[name], desired[name])}`,
    );
  }
}

/**
 * Throws the message of `rejectChange`, if it returns one, followed by
 * `hint`.
 */
export function assertChangeAllowed(
  id: string,
  rejectChange: RejectChange<any> | undefined,
  previous: Record<string, unknown>,
  desired: Record<string, unknown> | undefined,
  context: RejectChangeContext,
  hint?: string,
): void {
  const message = rejectChange?.(previous, desired, context);
  if (message === undefined) return;
  throw new Error(hint ? `${id}: ${message} ${hint}` : `${id}: ${message}`);
}

/**
 * Throws if the `rejectChange` of the orphan's class rejects its delete. An
 * orphan whose class isn't registered is skipped: the sweep keeps it.
 */
export function assertOrphanDeleteAllowed(
  registry: ResourceRegistry,
  stateNode: StateNode,
): void {
  assertChangeAllowed(
    stateNode.id,
    resolveResourceClass(registry, stateNode.type as ResourceType)
      ?.rejectChange,
    stateNode.params,
    undefined,
    { replace: false },
  );
}

/**
 * Upgrades a noop decision with a read of the remote. Callers reach this only
 * after decideAction returned noop, so a state node exists and the desired
 * params match it: the remote is the only remaining source of difference.
 */
export function decideDriftAction(opts: {
  resource: BaseResource;
  params: Record<string, unknown>;
  driftRead: DriftRead;
}): ResourceAction {
  const { resource, params, driftRead } = opts;
  if (driftRead.kind === "absent") {
    return { decision: "drift-recreate" };
  }

  const { patch, diff, replaceFields } = diffParams(
    resource.schema,
    pick(driftRead.output, params),
    pick(params, driftRead.output),
    { canUpdate: Boolean(resource.update) },
  );

  if (replaceFields.length > 0) {
    return { decision: "drift-replace", patch, diff, replaceFields };
  }
  if (Object.keys(patch).length > 0) {
    return { decision: "drift-update", patch, diff };
  }

  return { decision: "noop" };
}

/**
 * Keeps the fields of `values` that `other` also has. Drift compares only
 * fields present on both sides: a read need not return every param, and the
 * remote reports defaults for params left unset. Neither is drift, and
 * comparing them would plan the same drift on every deploy, and replace the
 * resource if the field is immutable or a key.
 */
function pick(
  values: Record<string, unknown>,
  other: Record<string, unknown>,
): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && other[key] !== undefined) picked[key] = value;
  }
  return picked;
}

/**
 * The resource's edges as state records them. Sorted and deduplicated, so a
 * resource whose edges have not changed compares equal to its record.
 */
export function getDependencyIds(
  resource: BaseResource,
  dependencies = resource.getDependencies(),
): string[] {
  const ids = dependencies.map((dependency) => dependency.id);
  return [...new Set(ids)].sort();
}

/**
 * The edges a state record holds. A record written before edges were
 * recorded has none, and takes the edges in code when it is still declared.
 */
export function recordedEdges(
  node: StateNode,
  resourceById: Map<string, BaseResource>,
): string[] {
  if (node.dependsOn) return node.dependsOn;
  const resource = resourceById.get(node.id);
  return resource ? getDependencyIds(resource) : [];
}

/** The edges of the retired instances that a state record lists. */
export function retiredEdges(node: StateNode | undefined): string[] {
  return (node?.retired ?? []).flatMap((instance) => instance.dependsOn);
}

export function hasSameEdges(
  stateNode: StateNode,
  dependsOn: string[],
): boolean {
  const recorded = stateNode.dependsOn;
  return (
    recorded !== undefined &&
    recorded.length === dependsOn.length &&
    recorded.every((id, index) => id === dependsOn[index])
  );
}
