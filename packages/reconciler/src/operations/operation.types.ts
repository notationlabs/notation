import type {
  BaseResource,
  DurableObject,
  DurableValue,
  ResourceGroupRef,
} from "@notation/resource";
import type { StateNode } from "@notation/state";
import type {
  DurableStepFn,
  StepRunner as YieldstarStepRunner,
} from "yieldstar";
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

/**
 * How an operation runs a step. Keys identify a step's cached result across a
 * replay; `scope` namespaces them so one operation can run at several call
 * sites in a single execution. `createStepRunner` ignores both.
 */
export type StepRunner = {
  /** The keyed overload of yieldstar's `step.run`. */
  run<F extends () => unknown>(
    key: string,
    fn: F & DurableStepFn<F>,
  ): AsyncGenerator<unknown, Awaited<ReturnType<F>>, unknown>;
  effect: YieldstarStepRunner["effect"];
  delay(key: string, ms: number): AsyncGenerator<unknown, void, unknown>;
  scope(prefix: string): StepRunner;
};

/**
 * The record an operation wants persisted; the driver owns the version.
 * Not derived with Omit, which would collapse against StateNode's index
 * signature and widen every field to unknown.
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
  // Not on StateNode itself, where it arrives through its index signature.
  group: ResourceGroupRef | null;
  [key: string]: DurableValue;
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
  /** Always present: an absent emitter is absorbed where the step is made
   * (`toEmitStep`, `durableEmitter`), not guarded here. */
  emit: EmitStep<OperationLifecycleEvent>;
  maxOperationAttempts?: number;
};

/**
 * Inputs resolved before an operation starts: the desired params, and — for
 * a resource with no read operation — the output the last write persisted.
 * An operation that resolved either itself could see a different answer from
 * the one the decision was taken against. Read takes exactly this; create
 * and update add their write.
 */
export type ResolvedResourceParams = ResourceOperationBaseParams & {
  resourceParams: Record<string, unknown>;
  persistedOutput?: Record<string, unknown>;
};

export type CreateResourceParams = ResolvedResourceParams & {
  /** Durable, because each create effect records them as its input. */
  resourceParams: DurableObject;
  /** Names the create effects, together with the resource ID. */
  executionId: string;
  persist: PersistState;
};

export type UpdateResourceParams = ResolvedResourceParams & {
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
