import { diff, detailedDiff } from "deep-object-diff";
import type { BaseResource } from "@notation/resource";
import type { StateNode } from "@notation/state";

export const UNKNOWN_AFTER_APPLY = { $unknown: "after-apply" } as const;

export type UnknownAfterApply = typeof UNKNOWN_AFTER_APPLY;

export type PlanDecision =
  | "create"
  | "update"
  | "drift-update"
  | "drift-recreate"
  | "delete-orphan"
  | "noop";

export type PlanDiff = {
  added: Record<string, unknown>;
  deleted: Record<string, unknown>;
  updated: Record<string, unknown>;
};

export type PlanNode = {
  id: string;
  type: string;
  decision: PlanDecision;
  diff?: PlanDiff;
  params: Record<string, unknown>;
  dependsOn: string[];
};

export type Plan = {
  createdAt: string;
  nodes: PlanNode[];
};

export type DriftRead =
  | { status: "found"; output: Record<string, unknown> }
  | { status: "not-found" };

export type ResourceAction =
  | { decision: "create" }
  | { decision: "noop" }
  | { decision: "drift-recreate" }
  | { decision: "update"; patch: Record<string, unknown>; diff: PlanDiff }
  | { decision: "drift-update"; patch: Record<string, unknown>; diff: PlanDiff };

export function decideAction(opts: {
  resource: BaseResource;
  stateNode?: StateNode;
  params?: Record<string, unknown>;
  driftRead?: DriftRead;
}): ResourceAction {
  const { resource, stateNode, params, driftRead } = opts;

  if (!stateNode) {
    return { decision: "create" };
  }

  const previousComparable = resource.toComparable(stateNode.params);
  const desiredComparable = resource.toComparable(params ?? {});
  const localPatch = diff(previousComparable, desiredComparable) as Record<
    string,
    unknown
  >;

  if (Object.keys(localPatch).length > 0) {
    return {
      decision: "update",
      patch: localPatch,
      diff: toPlanDiff(detailedDiff(previousComparable, desiredComparable)),
    };
  }

  if (!driftRead) {
    return { decision: "noop" };
  }

  if (driftRead.status === "not-found") {
    return { decision: "drift-recreate" };
  }

  const remoteDetailedDiff = detailedDiff(
    resource.toComparable(driftRead.output),
    resource.toComparable(stateNode.output),
  );
  const remotePatch = {
    ...remoteDetailedDiff.updated,
    ...remoteDetailedDiff.added,
  } as Record<string, unknown>;

  if (Object.keys(remotePatch).length === 0) {
    return { decision: "noop" };
  }

  return {
    decision: "drift-update",
    patch: remotePatch,
    diff: toPlanDiff(remoteDetailedDiff),
  };
}

export async function resolvePlanParams(
  resource: BaseResource,
): Promise<Record<string, unknown>> {
  let resolved: Record<string, unknown> | undefined;
  try {
    resolved = (await resource.getParams()) as Record<string, unknown>;
  } catch {
    resolved = undefined;
  }

  const params: Record<string, unknown> = {};

  if (resolved) {
    for (const [key, value] of Object.entries(resolved)) {
      params[key] = value === undefined ? UNKNOWN_AFTER_APPLY : value;
    }
    return params;
  }

  const config = resource.config as Record<string, unknown>;
  for (const [key, item] of Object.entries(resource.schema)) {
    if (item.propertyType !== "param") continue;
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

function toPlanDiff(diffResult: {
  added: object;
  deleted: object;
  updated: object;
}): PlanDiff {
  return {
    added: toJsonSafe(diffResult.added) as Record<string, unknown>,
    deleted: toJsonSafe(diffResult.deleted) as Record<string, unknown>,
    updated: toJsonSafe(diffResult.updated) as Record<string, unknown>,
  };
}

function toJsonSafe(value: unknown): unknown {
  if (value === undefined) return null;
  if (Array.isArray(value)) return value.map(toJsonSafe);
  if (value !== null && typeof value === "object") {
    const safe: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      safe[key] = toJsonSafe(entry);
    }
    return safe;
  }
  return value;
}
