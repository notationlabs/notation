import type { StateNode } from "@notation/state";
import * as v from "valibot";
import type { PersistedResourceState } from "../operations";
import { defineStore, type StoreSnapshot } from "./yieldstar";

// Store names are persisted identifiers, like the step keys mapped in
// index.ts: renaming one orphans every record stored under the old name.
// Notation-owned store names carry the "notation/" prefix, because an
// application may share a store client with these workflows.

/**
 * `looseObject` because PersistedResourceState carries an index signature: a
 * driver may persist fields this schema does not name, and `v.object` would
 * strip them at the store boundary.
 */
export const resourceStateStore = defineStore(
  "notation/resource-state",
  v.looseObject({
    id: v.string(),
    type: v.string(),
    // -1 and "" are BaseResource's defaults for a resource with no group.
    groupId: v.number(),
    groupType: v.string(),
    config: v.record(v.string(), v.unknown()),
    params: v.record(v.string(), v.unknown()),
    output: v.record(v.string(), v.unknown()),
    // Only the operations that leave a record behind: delete removes the
    // store, and drift repair persists as "update".
    lastOperation: v.picklist(["create", "update"]),
    lastOperationAt: v.string(),
  }),
);

export const deploymentHoldStore = defineStore(
  "notation/deployment-hold",
  v.object({ holder: v.nullable(v.string()) }),
);

// The schema validates exactly the record operations persist; drift between
// the two is a type error here.
({}) as v.InferOutput<
  typeof resourceStateStore.schema
> satisfies PersistedResourceState;

export type DeploymentHoldState = v.InferOutput<
  typeof deploymentHoldStore.schema
>;

/** A read of a resource record, carrying the identity a write is made against. */
export type ResourceSnapshot = StoreSnapshot<PersistedResourceState>;

export function toStateNode(snapshot: ResourceSnapshot): StateNode {
  return { ...snapshot.state, version: snapshot.version };
}
