import type { ReplaceField, ResourceType } from "@notation/resource";

export type OperationName = "create" | "read" | "update" | "delete";

/**
 * The order of the two halves of a replace. `create-first` creates the
 * replacement, moves the dependents to it, and deletes the replaced resource
 * at the end of the deploy. `delete-first` deletes the resource, and then
 * creates it again.
 */
export type ReplaceOrder = "create-first" | "delete-first";

export type OperationLifecycleStatus =
  "start" | "success" | "error" | "skip" | "dry-run";

export type OperationLifecycleEvent = {
  level: "info" | "error";
  event: "reconciler.operation.lifecycle";
  operation: OperationName;
  status: OperationLifecycleStatus;
  resourceId: string;
  resourceType: ResourceType;
  /**
   * `dependency-replaced`: the delete of a dependent that blocks the delete
   * of a replaced resource.
   * `taken-over`: a create that took over a resource that already existed.
   * `retired`: the delete of an instance that a create-first replace
   * retired.
   */
  reason?: string;
  /**
   * With the reason `dependency-replaced`: the resource whose replacement
   * deletes this one first. Plan names it in `PlanNode.replacedDependency`.
   */
  replacedDependency?: string;
  errorName?: string;
  errorMessage?: string;
};

export type DeployDecisionEvent = {
  level: "info";
  event: "reconciler.deploy.decision";
  resourceId: string;
  resourceType: ResourceType;
  decision:
    | "create"
    | "update"
    | "replace"
    | "drift-update"
    | "drift-replace"
    | "drift-recreate"
    | "noop";
  replaceFields?: ReplaceField[];
  /** Set with the decisions `replace` and `drift-replace`. */
  replaceOrder?: ReplaceOrder;
  /**
   * Set when deploy creates the resource without its contributions, as the
   * first member of a dependency cycle. A later decision for the same
   * resource applies its full params.
   */
  placeholder?: true;
};

export type DriftDetectedEvent = {
  level: "info";
  event: "reconciler.drift.detected";
  resourceId: string;
  resourceType: ResourceType;
  diff: Record<string, unknown>;
};

export type HoldWaitingEvent = {
  level: "warn";
  event: "reconciler.hold.waiting";
  deploymentId: string;
  executionId: string;
  holderExecutionId: string;
};

/**
 * A record was not deleted because its type has no class. In destroy, this
 * includes a desired resource whose record has a different type.
 */
export type OrphanDeletionSkippedEvent = {
  level: "warn";
  event: "reconciler.orphan-deletion.skipped";
  reason: "resource-type-not-registered";
  workflow: "deploy" | "destroy";
  resourceId: string;
  resourceType: ResourceType;
  /**
   * The orphans the skipped orphan depends on, directly or through another
   * orphan. In destroy, also the desired resources it depends on. These are
   * kept in place, because the skipped orphan still refers to them.
   */
  keptDependencies: string[];
};

/** A provider package named in state could not be loaded. */
export type ProviderLoadFailedEvent = {
  level: "warn";
  event: "reconciler.provider.load-failed";
  provider: string;
  errorMessage: string;
};

export type ReconcilerEvent =
  | OperationLifecycleEvent
  | DeployDecisionEvent
  | DriftDetectedEvent
  | HoldWaitingEvent
  | OrphanDeletionSkippedEvent
  | ProviderLoadFailedEvent;

export type ReconcilerEventEmitter = (
  event: ReconcilerEvent,
) => void | Promise<void>;

/**
 * The seam a driver fills in to deliver an event. Emission is a step so that
 * each driver decides how it is recorded: `toEmitStep` simply awaits the
 * emitter, while the durable driver's `durableEmitter` checkpoints it so that
 * replaying a workflow does not re-emit events it has already delivered.
 */
export type EmitStep<TEvent = ReconcilerEvent> = (
  event: TEvent,
) => AsyncGenerator<unknown, void, unknown>;

/**
 * Adapts a plain emitter to the driver seam, for drivers that just await.
 * Absorbs an absent emitter: the returned step then delivers nothing, so
 * downstream code always has an emit step and never guards.
 */
export function toEmitStep<TEvent>(
  emit?: (event: TEvent) => void | Promise<void>,
): EmitStep<TEvent> {
  return async function* (event) {
    await emit?.(event);
  };
}
