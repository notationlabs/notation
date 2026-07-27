import type { ResourceType } from "@notation/resource";
import type { MissingResourceRegistryMatchWarningEvent } from "./resource-registry";

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

export type ReconcilerDeployEvent = {
  level: "info";
  event: "reconciler.deploy.decision";
  resourceId: string;
  resourceType: string;
  decision: "create" | "update" | "drift-update" | "drift-recreate" | "noop";
};

export type ReconcilerDriftDetectedEvent = {
  level: "info";
  event: "reconciler.drift.detected";
  resourceId: string;
  resourceType: string;
  diff: Record<string, unknown>;
};

export type CoordinationWaitingEvent = {
  level: "warn";
  event: "reconciler.coordination.waiting";
  deploymentId: string;
  executionId: string;
  holderExecutionId: string;
};

export type ReconcilerEvent =
  | OperationLifecycleEvent
  | CoordinationWaitingEvent
  | ReconcilerDeployEvent
  | ReconcilerDriftDetectedEvent
  | MissingResourceRegistryMatchWarningEvent;

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

/** Adapts a plain emitter to the driver seam, for drivers that just await. */
export function toEmitStep<TEvent>(
  emit: ((event: TEvent) => void | Promise<void>) | undefined,
): EmitStep<TEvent> {
  return async function* (event) {
    await emit?.(event);
  };
}
