import type {
  BaseResource,
  NameScope,
  RecordedOutputs,
} from "@notation/resource";
import type { ReconcilerEventEmitter } from "../events";
import type { ReplaceRequest } from "../replace-request";
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
  /**
   * The replaces and credentials that the user asked for. A resume must
   * pass the request that the execution started with, or the replay decides
   * differently.
   */
  requested?: ReplaceRequest;
};

/** The options of deploy, with what deploy reads at its start. */
export type DeployContext = DurableDeployOptions & {
  /** The outputs that `~state` refs read, from state at the start. */
  recordedOutputs: RecordedOutputs;
  /** The resources that the deploy has reconciled so far. */
  reconciled: Set<BaseResource>;
};
