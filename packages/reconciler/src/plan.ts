import {
  UNKNOWN_AFTER_APPLY,
  diffParams,
  type BaseResource,
  type ParamsDiffDisplay,
  type ReplaceField,
} from "@notation/resource";
import type { StateNode } from "@notation/state";

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
  | "noop";

export type PlanDiff = ParamsDiffDisplay;

export type PlanNode = {
  id: string;
  type: string;
  decision: PlanDecision;
  diff?: PlanDiff;
  replaceFields?: ReplaceField[];
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

export function decideAction(opts: {
  resource: BaseResource;
  stateNode?: StateNode;
  params: Record<string, unknown>;
}): ResourceAction {
  const { resource, stateNode, params } = opts;
  if (!stateNode) {
    return { decision: "create" };
  }

  const { patch, diff, replaceFields } = diffParams(
    resource.schema,
    stateNode.params,
    params,
    { canUpdate: Boolean(resource.update) },
  );

  if (replaceFields.length > 0) {
    return { decision: "replace", patch, diff, replaceFields };
  }
  if (Object.keys(patch).length > 0) {
    return { decision: "update", patch, diff };
  }

  return { decision: "noop" };
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

export async function resolvePlanParams(
  resource: BaseResource,
): Promise<Record<string, unknown>> {
  const hasUnresolvedDependency = Object.values(resource.dependencies).some(
    (dependency) => dependency && dependency.output == null,
  );
  if (!hasUnresolvedDependency) {
    // Every dependency has an output, so an undefined param is one left
    // unset, not one waiting on a dependency, and is dropped.
    const resolved = (await resource.getParams()) as Record<string, unknown>;
    const params: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(resolved)) {
      if (value !== undefined) params[key] = value;
    }
    return params;
  }

  const params: Record<string, unknown> = {};
  const config = resource.config as Record<string, unknown>;
  for (const [key, item] of Object.entries(resource.schema)) {
    if (item.propertyType === "computed") continue;
    params[key] =
      key in config && config[key] !== undefined
        ? config[key]
        : UNKNOWN_AFTER_APPLY;
  }
  return params;
}

export function getDependencyIds(resource: BaseResource): string[] {
  return Object.values(resource.dependencies)
    .filter((dependency): dependency is BaseResource => Boolean(dependency))
    .map((dependency) => dependency.id);
}
