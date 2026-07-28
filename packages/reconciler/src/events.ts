import type { ResourceType } from "@notation/resource";

export type OperationName = "create" | "read" | "update" | "delete";

export type OperationLifecycleStatus =
  "start" | "success" | "error" | "skip" | "dry-run";

export type OperationLifecycleEvent = {
  level: "info" | "error";
  event: "reconciler.operation.lifecycle";
  operation: OperationName;
  status: OperationLifecycleStatus;
  resourceId: string;
  resourceType: ResourceType;
  reason?: string;
  errorName?: string;
  errorMessage?: string;
};

export type DeployDecisionEvent = {
  level: "info";
  event: "reconciler.deploy.decision";
  resourceId: string;
  resourceType: string;
  decision: "create" | "update" | "drift-update" | "drift-recreate" | "noop";
};

export type DriftDetectedEvent = {
  level: "info";
  event: "reconciler.drift.detected";
  resourceId: string;
  resourceType: string;
  diff: Record<string, unknown>;
};

export type HoldWaitingEvent = {
  level: "warn";
  event: "reconciler.hold.waiting";
  deploymentId: string;
  executionId: string;
  holderExecutionId: string;
};

export type OrphanDeletionSkippedEvent = {
  level: "warn";
  event: "reconciler.orphan-deletion.skipped";
  reason: "resource-type-not-registered";
  workflow: "deploy" | "destroy";
  resourceId: string;
  resourceType: ResourceType;
};

export type ReconcilerEvent =
  | OperationLifecycleEvent
  | DeployDecisionEvent
  | DriftDetectedEvent
  | HoldWaitingEvent
  | OrphanDeletionSkippedEvent;

export type ReconcilerEventEmitter = (
  event: ReconcilerEvent,
) => void | Promise<void>;

/**
 * The seam a driver fills in to deliver an event. Emission is a step so that
 * each driver decides how it is recorded: the in-process driver simply awaits
 * the emitter, while the durable driver checkpoints it so that replaying a
 * workflow does not re-emit events it has already delivered.
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
