import type { StateNode } from "@notation/state";
import * as v from "valibot";
import { defineStore } from "./yieldstar";

export const RESOURCE_CREATION_TOKEN = "$notationCreateToken";

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
    [RESOURCE_CREATION_TOKEN]: v.optional(v.string()),
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

export function toStateNode(snapshot: {
  state: StoredResourceState;
  version: number;
}): StateNode {
  const { [RESOURCE_CREATION_TOKEN]: _creationToken, ...state } =
    snapshot.state;
  return { ...state, rev: snapshot.version + 1 };
}

export function withoutRev(
  patch: Partial<StateNode>,
): Partial<StoredResourceState> {
  const { rev: _rev, ...stored } = patch;
  return stored;
}
