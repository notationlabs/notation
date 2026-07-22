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

export type ReconcilerEvent =
  | OperationLifecycleEvent
  | ReconcilerDeployEvent
  | ReconcilerDriftDetectedEvent
  | import("./resource-registry").MissingResourceRegistryMatchWarningEvent;

export type ReconcilerEventEmitter = (
  event: ReconcilerEvent,
) => void | Promise<void>;
