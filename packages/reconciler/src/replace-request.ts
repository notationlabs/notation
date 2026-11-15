import { createHash } from "node:crypto";
import type { BaseResource, Schema } from "@notation/resource";
import { isCreatingRecord, type StateNode } from "@notation/state";

/** A resource that `--replace` names, as `<id>@<instance hash>`. */
export type ReplaceTarget = {
  id: string;
  /** Optional for plan, and required for deploy. */
  instanceHash?: string;
};

/** The replaces that the user asked for, with `--replace`. */
export type ReplaceRequest = {
  replace: ReplaceTarget[];
  /**
   * The IDs, each also in `replace`, whose class's `rejectChange` deploy
   * does not call for the requested replace.
   */
  overrideLossProtection?: string[];
};

/** How deploy decides a resource that `--replace` names. */
export type RequestedReplace = { overrideLossProtection: boolean };

const INSTANCE_HASH = /^[0-9a-f]{8}$/;

/**
 * Reads `<id>@<instance hash>`. The ID is the part before the last `@`. A
 * value with no `@` is an ID with no hash.
 */
export function parseReplaceTarget(value: string): ReplaceTarget {
  const at = value.lastIndexOf("@");
  if (at < 0) return { id: value };
  const id = value.slice(0, at);
  const instanceHash = value.slice(at + 1);
  if (!id || !INSTANCE_HASH.test(instanceHash)) {
    throw new Error(
      `--replace ${value} is not <resource id>@<instance hash>. The instance hash is 8 hex characters. notation plan --replace <resource id> prints the command with the hash.`,
    );
  }
  return { id, instanceHash };
}

/**
 * The first 8 hex characters of a SHA-256 of the deployment ID and the
 * primary key in the record's output. The deployment ID is included because
 * some primary keys are the same in every stage.
 */
export function instanceHash(
  deploymentId: string,
  resource: { schema: Schema },
  record: StateNode,
): string {
  const key = Object.entries(resource.schema)
    .filter(([, item]) => (item as { primaryKey?: true }).primaryKey)
    .map(([name]) => name)
    .sort()
    .map((name) => [name, record.output[name] ?? null]);
  return createHash("sha256")
    .update(JSON.stringify([deploymentId, key]))
    .digest("hex")
    .slice(0, 8);
}

/** The options for `decideAction` when the request names the resource. */
export function requestedReplace(
  request: ReplaceRequest | undefined,
  id: string,
): RequestedReplace | undefined {
  if (!request?.replace.some((target) => target.id === id)) return undefined;
  return {
    overrideLossProtection: Boolean(
      request.overrideLossProtection?.includes(id),
    ),
  };
}

/**
 * Throws if the request names a resource that it cannot replace, or gives
 * an instance hash that does not match. Deploy requires each hash, and plan
 * checks a hash when it is given.
 */
export function assertReplaceRequest(
  request: ReplaceRequest | undefined,
  opts: {
    resources: BaseResource[];
    records: StateNode[];
    deploymentId: string;
    point: "plan" | "deploy";
  },
): void {
  if (!request) return;
  const ids = new Set(request.replace.map((target) => target.id));
  for (const id of request.overrideLossProtection ?? []) {
    if (!ids.has(id)) {
      throw new Error(
        `--override-loss-protection ${id} needs --replace ${id}.`,
      );
    }
  }
  const resourceById = new Map(opts.resources.map((r) => [r.id, r]));
  const recordById = new Map(opts.records.map((node) => [node.id, node]));
  for (const { id, instanceHash: given } of request.replace) {
    const resource = resourceById.get(id);
    const record = recordById.get(id);
    if (!record) {
      throw new Error(
        resource
          ? `${id} is not in state, so there is nothing to replace. Deploy will create it.`
          : `${id} is not in state or in code, so there is nothing to replace.`,
      );
    }
    if (!resource) {
      throw new Error(`${id} is no longer in code. Deploy will delete it.`);
    }
    if (isCreatingRecord(record)) {
      throw new Error(
        `${id} has a create that an earlier deploy did not finish. Run deploy without --replace to recover it first.`,
      );
    }
    if (given === undefined) {
      if (opts.point === "plan") continue;
      throw new Error(
        `--replace ${id} needs the instance hash, as --replace ${id}@<instance hash>. Run notation plan --replace ${id} to print the deploy command with the hash.`,
      );
    }
    const actual = instanceHash(opts.deploymentId, resource, record);
    if (actual !== given) {
      throw new Error(
        `${id} has the instance hash ${actual} in this stage, not ${given}.`,
      );
    }
  }
}
