/**
 * The deployment hold: an exclusive claim on a deployment for the length of a
 * workflow execution. It lives in the `deployment-coordination` store — that
 * store name, the `notation:coordination:*` step keys, and the
 * `reconciler.coordination.waiting` event are persisted or published strings
 * and keep the older "coordination" wording; the identifiers here do not.
 */
import type { ReconcilerEventEmitter } from "../events";
import { durableEmitter, scopeStep } from "./step";
import { deploymentCoordinationStore, type CoordinationState } from "./stores";
import type { DurableStep, StoreClient, WorkflowStore } from "./yieldstar";

type DeploymentHoldOptions = {
  deploymentId: string;
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
): AsyncGenerator<any, WorkflowStore<CoordinationState>, any> {
  const hold = yield* step.store(deploymentCoordinationStore, {
    id: opts.deploymentId,
    initial: { holder: null },
  });

  const snapshot = yield* hold.get("notation:coordination:inspect");
  const holder = snapshot.state.holder;
  if (holder !== null && holder !== opts.executionId) {
    yield* durableEmitter(
      scopeStep(step, "notation:coordination"),
      opts.emit,
    )({
      level: "warn",
      event: "reconciler.coordination.waiting",
      deploymentId: opts.deploymentId,
      executionId: opts.executionId,
      holderExecutionId: holder,
    });
  }

  yield* hold.take(
    "notation:coordination:acquire",
    (state) => state.holder === null || state.holder === opts.executionId,
    (draft) => {
      draft.holder = opts.executionId;
    },
  );

  return hold;
}

function releaseDeploymentHold(
  hold: WorkflowStore<CoordinationState>,
  executionId: string,
) {
  return hold.update("notation:coordination:release", (draft) => {
    if (draft.holder === executionId) draft.holder = null;
  });
}

/**
 * Runs `body` while holding the deployment, releasing the hold only once
 * `body` has completed. A failed or suspended execution keeps the hold, which
 * is what makes it safe to resume: the resumed execution replays `take` from
 * the step cache and so never re-acquires anything, so a hold released on the
 * way out would leave the resumption mutating a deployment it does not hold.
 *
 * The cost is that an execution which will never be resumed holds its
 * deployment indefinitely. That is deliberate — nothing here can tell "will
 * retry" from "abandoned" — and it is resolved by an operator calling
 * `takeOverDeploymentHold`.
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

export type DeploymentHoldTakeover =
  | { taken: true; previousHolder: string }
  | { taken: false; holder: string | null };

/**
 * Clears a deployment hold left by an execution that will not be resumed, so
 * that later deployments are not blocked behind it. Named separately from the
 * workflow path because it is the only supported way out of that state: the
 * hold is otherwise released solely by an execution completing.
 *
 * The write is conditional on `fromExecutionId` still being the named holder,
 * so it cannot clear a hold that has since been released and re-taken by
 * another execution. Confirm the holder is genuinely dead first: it may still
 * be mid-flight, and taking its hold away permits a concurrent mutation of
 * the same deployment.
 *
 * Throws if the deployment has no coordination store, i.e. if it has never
 * been deployed.
 */
export async function takeOverDeploymentHold(params: {
  storeClient: StoreClient;
  deploymentId: string;
  fromExecutionId: string;
  toExecutionId?: string | null;
}): Promise<DeploymentHoldTakeover> {
  const { storeClient, deploymentId, fromExecutionId } = params;
  const read = () =>
    storeClient.getStore({
      definition: deploymentCoordinationStore,
      id: deploymentId,
    });

  const snapshot = await read();
  if (snapshot.state.holder !== fromExecutionId) {
    return { taken: false, holder: snapshot.state.holder };
  }

  const result = await storeClient.updateStoreFrom({
    definition: deploymentCoordinationStore,
    id: deploymentId,
    snapshot,
    updater: (draft) => {
      draft.holder = params.toExecutionId ?? null;
    },
  });

  if (!result.updated) {
    return { taken: false, holder: (await read()).state.holder };
  }

  return { taken: true, previousHolder: fromExecutionId };
}
