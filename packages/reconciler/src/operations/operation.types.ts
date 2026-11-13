import type {
  ResourceDeletion,
  BaseResource,
  DurableValue,
  ResourceGroupRef,
} from "@notation/resource";
import type { RetiredInstance, StateNode } from "@notation/state";
import type {
  DurableStepFn,
  StepRunner as DurableStepRunner,
} from "@notation/durable";
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
  /** The keyed overload of @notation/durable's `step.run`. */
  run<F extends () => unknown>(
    key: string,
    fn: F & DurableStepFn<F>,
  ): AsyncGenerator<unknown, Awaited<ReturnType<F>>, unknown>;
  effect: DurableStepRunner["effect"];
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
  | "provider"
  | "config"
  | "params"
  | "output"
  | "lastOperation"
  | "lastOperationAt"
> & {
  // Not on StateNode itself, where it arrives through its index signature.
  group: ResourceGroupRef | null;
  // Required here, though optional on StateNode: every write records edges.
  dependsOn: string[];
  /**
   * Left out to carry forward the list that the record holds. See
   * `PersistState`.
   */
  retired?: RetiredInstance[];
  [key: string]: DurableValue;
};

/** The record to write for `node`, with `dependsOn` as its edges. */
export function toPersistedState(
  node: StateNode,
  dependsOn: string[],
): PersistedResourceState {
  const { version: _, ...record } = node;
  return {
    ...record,
    group: (record.group ?? null) as ResourceGroupRef | null,
    dependsOn,
  };
}

/**
 * How the driver writes state. Both are steps so the driver can carry its own
 * concurrency control: in a workflow that is a store write stamped with the
 * step that made it, so a replay does not repeat it.
 *
 * An operation that writes the record more than once names each write but
 * the last with a `stage`, so that each write has its own step key. Each
 * write is made against the record the one before it left. `null` clears the
 * record.
 *
 * A write that leaves out `retired` keeps the retired instances that the
 * record lists, except a `restored` write, which writes the record as it is
 * given. Neither `null` nor a removal may drop a record that lists retired
 * instances.
 */
export type PersistState = (
  next: PersistedResourceState | null,
  stage?: PersistStage,
) => AsyncGenerator<unknown, void, unknown>;

/**
 * `restored` writes back the record that a failed create started from, or
 * that the replaced resource had. It clears the record if there is none.
 * `retired:<n>` removes retired instance <n>, from 0, once deploy has deleted
 * it.
 */
export type PersistStage =
  "creating" | "taken-over" | "restored" | `retired:${number}`;

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
  /** Names the create effects, together with the resource ID. */
  executionId: string;
  /**
   * The record that an earlier execution left and this create started from:
   * a "creating" record, or the record of a resource that the drift read
   * reported as gone.
   */
  prior?: StateNode;
  /**
   * Set for the create of a replacement: the record of the resource that it
   * replaces. A delete-first replace has removed it.
   */
  replaces?: StateNode;
  /**
   * Set for a create-first replace: the list of retired instances that the
   * "creating" record holds, with the replaced resource added.
   */
  retired?: RetiredInstance[];
  /** The edges to record with the resource. */
  dependsOn: string[];
  persist: PersistState;
};

export type UpdateResourceParams = ResolvedResourceParams & {
  patch: Record<string, unknown>;
  /** The edges to record with the resource. */
  dependsOn: string[];
  persist: PersistState;
};

export type DeleteResourceParams = ResourceOperationBaseParams & {
  remove: RemoveState;
  /** Passed to the resource's `delete`. */
  deletion?: ResourceDeletion;
  /** Set when the record is a "creating" record: its params. */
  creatingParams?: Record<string, unknown>;
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
