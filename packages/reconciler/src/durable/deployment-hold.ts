/**
 * The deployment hold: an exclusive claim on a deployment for the length of a
 * workflow execution.
 */
import type { ReconcilerEventEmitter } from "../events";
import type { DurableStateBackend } from "./state-backend";
import { durableEmitter, scopeStep } from "./step";
import { deploymentHoldStore, type DeploymentHoldState } from "./stores";
import type { DurableStep, StoreClient, WorkflowStore } from "./yieldstar";

type DeploymentHoldOptions = {
  /** Deployment identity comes from the state backend. */
  state: Pick<DurableStateBackend, "deploymentId">;
  executionId: string;
  emit?: ReconcilerEventEmitter;
};

/**
 * Prevents concurrent executions from mutating the same deployment. Names
 * the holder so an operator can resume it after a crash.
 */
async function* acquireDeploymentHold(
  step: DurableStep,
  opts: DeploymentHoldOptions,
): AsyncGenerator<any, WorkflowStore<DeploymentHoldState>, any> {
  const hold = yield* step.store(deploymentHoldStore, {
    id: opts.state.deploymentId,
    initial: { holder: null },
  });

  const snapshot = yield* hold.get("notation:hold:inspect");
  const holder = snapshot.state.holder;
  if (holder !== null && holder !== opts.executionId) {
    yield* durableEmitter(
      scopeStep(step, "notation:hold"),
      opts.emit,
    )({
      level: "warn",
      event: "reconciler.hold.waiting",
      deploymentId: opts.state.deploymentId,
      executionId: opts.executionId,
      holderExecutionId: holder,
    });
  }

  yield* hold.take(
    "notation:hold:acquire",
    (state) => state.holder === null || state.holder === opts.executionId,
    (draft) => {
      draft.holder = opts.executionId;
    },
  );

  return hold;
}

function releaseDeploymentHold(
  hold: WorkflowStore<DeploymentHoldState>,
  executionId: string,
) {
  return hold.update("notation:hold:release", (draft) => {
    if (draft.holder === executionId) draft.holder = null;
  });
}

/**
 * Runs `body` while holding the deployment, releasing the hold only once
 * `body` has completed. A failed or suspended execution keeps its hold: a
 * resumed execution replays `take` from the step cache without re-acquiring
 * anything, so it must still be the holder. An execution that will never be
 * resumed holds its deployment until an operator calls
 * `clearDeploymentHold`.
 */
export async function* withDeploymentHold(
  step: DurableStep,
  opts: DeploymentHoldOptions,
  body: () => AsyncGenerator<any, void, any>,
): AsyncGenerator<any, void, any> {
  const hold = yield* acquireDeploymentHold(step, opts);
  yield* body();
  yield* releaseDeploymentHold(hold, opts.executionId);
}

export type DeploymentHoldClearance =
  | { cleared: true; previousHolder: string }
  | { cleared: false; holder: string | null };

/**
 * Clears the hold of an execution that will not be resumed, so later
 * deployments are not blocked behind it.
 *
 * The write is conditional on `fromExecutionId` still being the named holder,
 * so it cannot clear a hold that has since moved to another execution.
 * Confirm the holder is genuinely dead first: clearing a live execution's
 * hold permits a concurrent mutation of the same deployment.
 *
 * Throws if the deployment has no hold store, i.e. has never been deployed.
 */
export async function clearDeploymentHold(params: {
  storeClient: StoreClient;
  deploymentId: string;
  fromExecutionId: string;
}): Promise<DeploymentHoldClearance> {
  const { storeClient, deploymentId, fromExecutionId } = params;
  const read = () =>
    storeClient.getStore({
      definition: deploymentHoldStore,
      id: deploymentId,
    });

  const snapshot = await read();
  if (snapshot.state.holder !== fromExecutionId) {
    return { cleared: false, holder: snapshot.state.holder };
  }

  const result = await storeClient.updateStoreFrom({
    definition: deploymentHoldStore,
    id: deploymentId,
    snapshot,
    updater: (draft) => {
      draft.holder = null;
    },
  });

  if (!result.updated) {
    return { cleared: false, holder: (await read()).state.holder };
  }

  return { cleared: true, previousHolder: fromExecutionId };
}
