import type { StateNode } from "@notation/state";
import { isPlainObject } from "@notation/utils";
import { defineStore, type StandardSchemaV1 } from "./yieldstar";

export type StoredResourceState = Omit<StateNode, "rev">;
export type CoordinationState = { holder: string | null };

const storedResourceStateSchema = plainObjectSchema<StoredResourceState>(
  "Stored resource state",
  (value) =>
    typeof value.id === "string" &&
    typeof value.type === "string" &&
    isPlainObject(value.config) &&
    isPlainObject(value.params) &&
    isPlainObject(value.output),
);
const coordinationStateSchema = plainObjectSchema<CoordinationState>(
  "Deployment coordination state",
  (value) =>
    "holder" in value &&
    (value.holder === null || typeof value.holder === "string"),
);

export const resourceStateStore = defineStore(
  "notation/resource-state",
  storedResourceStateSchema,
);

export const deploymentCoordinationStore = defineStore(
  "notation/deployment-coordination",
  coordinationStateSchema,
);

export function toStateNode(snapshot: {
  state: StoredResourceState;
  version: number;
}): StateNode {
  return { ...snapshot.state, rev: snapshot.version + 1 } as StateNode;
}

export function withoutRev(
  patch: Partial<StateNode>,
): Partial<StoredResourceState> {
  const { rev: _rev, ...stored } = patch;
  return stored;
}

function plainObjectSchema<T extends Record<string, unknown>>(
  label: string,
  refine: (value: Record<string, unknown>) => boolean,
): StandardSchemaV1<T, T> {
  return {
    "~standard": {
      version: 1,
      vendor: "notation",
      validate(value) {
        if (!isPlainObject(value) || !refine(value)) {
          return { issues: [{ message: `${label} is invalid` }] };
        }
        return { value: value as T };
      },
    },
  };
}
