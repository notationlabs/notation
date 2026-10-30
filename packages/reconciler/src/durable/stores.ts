import type { DurableValue } from "@notation/resource";
import type { StateNode } from "@notation/state";
import * as v from "valibot";
import type { PersistedResourceState } from "../operations";
import { defineStore, type StoreSnapshot } from "./yieldstar";

// Store names are persisted identifiers, like the step keys mapped in
// index.ts: renaming one orphans every record stored under the old name.
// Notation-owned store names carry the "notation/" prefix, because an
// application may share a store client with these workflows.

// Yieldstar checks every value it records when it encodes the value, so this
// only gives the schema a durable output type.
const durableValue = v.custom<DurableValue>(() => true);
const durableRecord = v.record(v.string(), durableValue);

/**
 * `objectWithRest` because PersistedResourceState carries an index signature:
 * a driver may persist fields this schema does not name, and `v.object` would
 * strip them at the store boundary.
 */
const resourceRecordSchema = v.objectWithRest(
  {
    id: v.string(),
    type: v.string(),
    // null for a resource that is in no group.
    group: v.nullable(v.object({ type: v.string(), id: v.string() })),
    config: durableRecord,
    params: durableRecord,
    output: durableRecord,
    // Only the operations that leave a record behind: delete removes the
    // store, and drift repair persists as "update".
    lastOperation: v.picklist(["create", "update"]),
    lastOperationAt: v.string(),
  },
  durableValue,
);

export type ResourceRecord = v.InferOutput<typeof resourceRecordSchema>;

/**
 * Every store operation creates a missing store from `initial`, including a
 * read from outside a workflow. A `null` state means the resource has no
 * record, so a read that creates the store records nothing.
 */
export const resourceStateStore = defineStore(
  "notation/resource-state",
  v.nullable(resourceRecordSchema),
  { initial: () => null },
);

export const deploymentHoldStore = defineStore(
  "notation/deployment-hold",
  v.object({ holder: v.nullable(v.string()) }),
  { initial: () => ({ holder: null }) },
);

// The schema validates exactly the record operations persist; drift between
// the two is a type error here.
({}) as ResourceRecord satisfies PersistedResourceState;

export type DeploymentHoldState = v.InferOutput<
  typeof deploymentHoldStore.schema
>;

/**
 * A read of a resource record, carrying the identity a write is made against.
 * Its state is `null` when the resource has no record.
 */
export type ResourceSnapshot = StoreSnapshot<ResourceRecord | null>;

export function toStateNode(snapshot: ResourceSnapshot): StateNode | undefined {
  if (snapshot.state === null) return undefined;
  return { ...snapshot.state, version: snapshot.version };
}
