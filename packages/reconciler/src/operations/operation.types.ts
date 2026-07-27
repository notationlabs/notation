import type { BaseResource } from "@notation/resource";
import type { State, StateNode } from "@notation/state";
import type {
  EmitStep,
  OperationLifecycleEvent,
  OperationLifecycleStatus,
  OperationName,
} from "../events";

export type {
  OperationLifecycleEvent,
  OperationLifecycleStatus,
  OperationName,
} from "../events";

export type OperationEventEmitter = EmitStep<OperationLifecycleEvent>;

export type StepRunner = {
  run<T>(fn: () => T | Promise<T>): AsyncGenerator<unknown, T, unknown>;
  run<T>(
    key: string,
    fn: () => T | Promise<T>,
  ): AsyncGenerator<unknown, T, unknown>;
  delay(ms: number): AsyncGenerator<unknown, void, unknown>;
  delay(key: string, ms: number): AsyncGenerator<unknown, void, unknown>;
};

/**
 * The record an operation wants persisted; the driver owns the revision.
 * Spelled out rather than derived with Omit, which would collapse against
 * StateNode's index signature and widen every field to unknown.
 */
export type PersistedResourceState = Pick<
  StateNode,
  | "id"
  | "type"
  | "config"
  | "params"
  | "output"
  | "lastOperation"
  | "lastOperationAt"
> & {
  // Not on StateNode itself, where they arrive through its index signature.
  groupId: number;
  groupType: string;
  [key: string]: unknown;
};

/**
 * How a driver writes state. Both are steps so that each driver can carry its
 * own concurrency control: in process that is a compare-and-set against the
 * revision read before the operation, and in a workflow it is a store write
 * stamped with the step that made it, so a replay does not repeat it.
 */
export type PersistState = (
  next: PersistedResourceState,
) => AsyncGenerator<unknown, void, unknown>;

export type RemoveState = () => AsyncGenerator<unknown, void, unknown>;

export type ResourceOperationBaseParams = {
  resource: BaseResource;
  state: Pick<State, "get">;
  dryRun?: boolean;
  emit?: OperationEventEmitter;
  maxOperationAttempts?: number;
};

export type CreateResourceParams = ResourceOperationBaseParams & {
  persist: PersistState;
};

export type ReadResourceParams = ResourceOperationBaseParams;

export type UpdateResourceParams = ResourceOperationBaseParams & {
  patch: Record<string, unknown>;
  persist: PersistState;
};

export type DeleteResourceParams = ResourceOperationBaseParams & {
  remove: RemoveState;
};

export function getErrorDetails(err: unknown): {
  errorName: string;
  errorMessage: string;
} {
  if (err instanceof Error) {
    return {
      errorName: err.name,
      errorMessage: err.message,
    };
  }

  return {
    errorName: "UnknownError",
    errorMessage: String(err),
  };
}

export async function* emitLifecycleEvent(
  params: ResourceOperationBaseParams,
  operation: OperationName,
  status: OperationLifecycleStatus,
  extra: Partial<OperationLifecycleEvent> = {},
): AsyncGenerator<unknown, void, unknown> {
  if (!params.emit) return;

  yield* params.emit({
    level: status === "error" ? "error" : "info",
    event: "reconciler.operation.lifecycle",
    operation,
    status,
    resourceId: params.resource.id,
    resourceType: params.resource.type,
    ...extra,
  });
}
