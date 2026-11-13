import type {
  BaseResource,
  NameScope,
  RecordedOutputs,
} from "@notation/resource";
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
  /** The app and stage that start each generated physical name. */
  nameScope: NameScope;
};

/** The options of deploy, with what deploy reads at its start. */
export type DeployContext = DurableDeployOptions & {
  /** The outputs that `~state` refs read, from state at the start. */
  recordedOutputs: RecordedOutputs;
};
