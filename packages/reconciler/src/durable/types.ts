import type { BaseResource } from "@notation/resource";
import type { ReconcilerEventEmitter } from "../events";
import type { ResourceRegistry } from "../resource-registry";
import type { DurableStateBackend } from "./state-backend";

export type PollOptions = {
  maxAttempts: number;
  retryInterval: number;
};

export const DEFAULT_RETRY_OPTIONS: PollOptions = {
  maxAttempts: 10,
  retryInterval: 1_000,
};

export const DEFAULT_READ_POLL_OPTIONS: PollOptions = {
  maxAttempts: 30,
  retryInterval: 1_000,
};

export type DurableOperationOptions = {
  deploymentId: string;
  executionId: string;
  resources: BaseResource[];
  state: DurableStateBackend;
  registry?: ResourceRegistry;
  dryRun?: boolean;
  emit?: ReconcilerEventEmitter;
  retryOptions?: PollOptions;
  readPollOptions?: PollOptions;
};

export type DurableDeployOptions = DurableOperationOptions & {
  driftDetection?: boolean;
};

export type DurableDestroyOptions = DurableOperationOptions;
