import type { BaseResource } from "@notation/resource";
import type { ReconcilerEventEmitter } from "../events";
import type { ResourceRegistry } from "../resource-registry";
import type { DurableStateBackend } from "./state-backend";

export type DurableWorkflowOptions = {
  executionId: string;
  resources: BaseResource[];
  state: DurableStateBackend;
  registry?: ResourceRegistry;
  dryRun?: boolean;
  emit?: ReconcilerEventEmitter;
  maxOperationAttempts?: number;
};

export type DurableDeployOptions = DurableWorkflowOptions & {
  driftDetection?: boolean;
};
