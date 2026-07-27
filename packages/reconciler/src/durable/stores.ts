import type { StateNode } from "@notation/state";
import * as v from "valibot";
import { defineStore, type StoreSnapshot } from "./yieldstar";

export const resourceStateStore = defineStore(
  "resource-state",
  v.looseObject({
    id: v.string(),
    type: v.string(),
    config: v.record(v.string(), v.unknown()),
    params: v.record(v.string(), v.unknown()),
    output: v.record(v.string(), v.unknown()),
    lastOperation: v.picklist(["drift", "create", "update", "delete"]),
    lastOperationAt: v.string(),
  }),
);

export const deploymentCoordinationStore = defineStore(
  "deployment-coordination",
  v.object({ holder: v.nullable(v.string()) }),
);

export type StoredResourceState = v.InferOutput<
  typeof resourceStateStore.schema
>;
export type CoordinationState = v.InferOutput<
  typeof deploymentCoordinationStore.schema
>;

/** A read of a resource record, carrying the identity a write is made against. */
export type ResourceSnapshot = StoreSnapshot<StoredResourceState>;

/** Store versions count from zero, state revisions from one. */
export function toStateNode(snapshot: ResourceSnapshot): StateNode {
  return { ...snapshot.state, rev: snapshot.version + 1 };
}
