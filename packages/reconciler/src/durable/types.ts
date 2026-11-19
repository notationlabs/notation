import type { BaseResource, RecordedOutputs } from "@notation/resource";
import type { ReconcilerEventEmitter } from "../events";
import type { Overrides } from "../overrides";
import type { PrefetchedValues } from "../prefetch";
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
  /** The app that starts each generated physical name. */
  app: string;
  /** The stage that follows the app in each generated physical name. */
  stage: string;
  /**
   * The replaces and credentials that the user asked for. A resume must
   * pass the overrides that the execution started with, or the replay decides
   * differently.
   */
  overrides?: Overrides;
};

/** The options of deploy, with what deploy reads at its start. */
export type DeployContext = DurableDeployOptions & {
  /** The outputs that `~state` refs read, from state at the start. */
  recordedOutputs: RecordedOutputs;
  /**
   * What each class's `prefetch` returned in this delivery of deploy. The
   * first call in a delivery calls `prefetch`, and later calls return the
   * same promise. Call it only where a `read` or `loadCredential` runs.
   */
  prefetched: () => Promise<PrefetchedValues>;
  /** The resources that the deploy has reconciled so far. */
  reconciled: Set<BaseResource>;
};
