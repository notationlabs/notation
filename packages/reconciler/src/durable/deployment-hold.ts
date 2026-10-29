/**
 * The deployment hold: an exclusive claim on a deployment for the length of a
 * workflow execution.
 */
import type { ReconcilerEventEmitter } from "../events";
import type { DurableStateBackend } from "./state-backend";
import { durableEmitter, scopeStep } from "./step";
import { deploymentHoldStore, type DeploymentHoldState } from "./stores";
import {
  InfrastructureError,
  type DurableStep,
  type StoreClient,
  type WorkflowStore,
} from "./yieldstar";

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
  const hold = step.store(deploymentHoldStore, { id: opts.state.deploymentId });

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
  key: string,
) {
  return hold.update(key, (draft) => {
    if (draft.holder === executionId) draft.holder = null;
  });
}

/**
 * Runs `body` while holding the deployment, and releases the hold when `body`
 * completes or throws. A thrown error fails the execution permanently, so
 * nothing would resume it to release the hold later.
 *
 * Two cases keep the hold:
 *
 *   1. A suspended execution never reaches the catch. When it resumes, it
 *      replays `take` from the step cache without acquiring the hold again,
 *      so it must still be the holder.
 *   2. An `InfrastructureError` ends the delivery rather than the execution,
 *      and the dispatcher delivers the execution again.
 *
 * An execution that crashed and will never be resumed holds its deployment
 * until an operator calls `clearDeploymentHold`.
 */
export async function* withDeploymentHold(
  step: DurableStep,
  opts: DeploymentHoldOptions,
  body: () => AsyncGenerator<any, void, any>,
): AsyncGenerator<any, void, any> {
  const hold = yield* acquireDeploymentHold(step, opts);
  try {
    yield* body();
  } catch (error) {
    if (InfrastructureError.is(error)) throw error;
    yield* releaseDeploymentHold(
      hold,
      opts.executionId,
      "notation:hold:release-failed",
    );
    throw error;
  }
  yield* releaseDeploymentHold(hold, opts.executionId, "notation:hold:release");
}

export type DeploymentHoldClearance =
  | { cleared: true; previousHolder: string }
  | { cleared: false; holder: string | null };

/**
 * Clears the hold of an execution that has not ended and will not be resumed,
 * so later deployments are not blocked behind it. An execution that failed
 * has already released its hold.
 *
 * The write is conditional on `fromExecutionId` still being the named holder,
 * so it cannot clear a hold that has since moved to another execution.
 * Confirm the holder is genuinely dead first: clearing a live execution's
 * hold permits a concurrent mutation of the same deployment.
 *
 * Returns `{ cleared: false, holder: null }` for a deployment that was never
 * deployed.
 */
export async function clearDeploymentHold(params: {
  storeClient: StoreClient;
  deploymentId: string;
  fromExecutionId: string;
}): Promise<DeploymentHoldClearance> {
  const { storeClient, deploymentId, fromExecutionId } = params;
  const hold = storeClient.store(deploymentHoldStore, deploymentId);

  const snapshot = await hold.get();
  if (snapshot.state.holder !== fromExecutionId) {
    return { cleared: false, holder: snapshot.state.holder };
  }

  const result = await hold.updateFrom(snapshot, (draft) => {
    draft.holder = null;
  });

  if (!result.updated) {
    return { cleared: false, holder: (await hold.get()).state.holder };
  }

  return { cleared: true, previousHolder: fromExecutionId };
}
