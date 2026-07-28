import type { BaseResource } from "@notation/resource";
import type { StateNode } from "@notation/state";
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

/**
 * How an operation runs a step, and how it namespaces the steps it runs.
 *
 * Keys are mandatory. A driver may ignore them — the in-process one does —
 * but a keyless step would have to derive a key from its call site, which for
 * a step reached through `scope` is the scoping wrapper's call site rather
 * than the caller's, so any two keyless steps under one scope would collide.
 *
 * `scope` is the seam that lets one operation run at several call sites in a
 * single execution: in process it is the identity, and in a workflow it
 * prefixes the keys the runtime caches against.
 */
export type StepRunner = {
  run<T>(
    key: string,
    fn: () => T | Promise<T>,
  ): AsyncGenerator<unknown, T, unknown>;
  delay(key: string, ms: number): AsyncGenerator<unknown, void, unknown>;
  scope(prefix: string): StepRunner;
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
 * How the driver writes state. Both are steps so the driver can carry its own
 * concurrency control: in a workflow that is a store write stamped with the
 * step that made it, so a replay does not repeat it.
 */
export type PersistState = (
  next: PersistedResourceState,
) => AsyncGenerator<unknown, void, unknown>;

export type RemoveState = () => AsyncGenerator<unknown, void, unknown>;

export type ResourceOperationBaseParams = {
  resource: BaseResource;
  dryRun?: boolean;
  emit?: OperationEventEmitter;
  maxOperationAttempts?: number;
};

/**
 * Everything a read needs is resolved before the operation starts: the
 * desired params, and — for a resource with no read operation — the output
 * the last write persisted. An operation that resolved either itself could
 * see a different answer from the one the decision was taken against.
 */
export type ReadResourceParams = ResourceOperationBaseParams & {
  resourceParams: Record<string, unknown>;
  persistedOutput?: Record<string, unknown>;
};

export type CreateResourceParams = ReadResourceParams & {
  persist: PersistState;
};

export type UpdateResourceParams = ReadResourceParams & {
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
