import type { ReconcilerEventEmitter } from "../events";
import { emitEvent } from "./emit";
import { deploymentCoordinationStore, type CoordinationState } from "./stores";
import type { DurableStep, WorkflowStore } from "./yieldstar";

type CoordinationOptions = {
  deploymentId: string;
  executionId: string;
  emit?: ReconcilerEventEmitter;
};

/**
 * Prevents concurrent executions from mutating the same deployment. Names
 * the holder so an operator can resume it after a crash.
 */
export async function* acquireDeploymentCoordination(
  step: DurableStep,
  opts: CoordinationOptions,
): AsyncGenerator<any, WorkflowStore<CoordinationState>, any> {
  const coordination = yield* step.store(deploymentCoordinationStore, {
    id: opts.deploymentId,
    initial: { holder: null },
  });

  const snapshot = yield* coordination.get("notation:coordination:inspect");
  const holder = snapshot.state.holder;
  if (holder !== null && holder !== opts.executionId) {
    yield* emitEvent(step, "notation:coordination:waiting", opts.emit, () => ({
      level: "warn",
      event: "reconciler.coordination.waiting",
      deploymentId: opts.deploymentId,
      executionId: opts.executionId,
      holderExecutionId: holder,
    }));
  }

  yield* coordination.take(
    "notation:coordination:acquire",
    (state) => state.holder === null || state.holder === opts.executionId,
    (draft) => {
      draft.holder = opts.executionId;
    },
  );

  return coordination;
}

export function releaseDeploymentCoordination(
  coordination: WorkflowStore<CoordinationState>,
  executionId: string,
) {
  return coordination.update("notation:coordination:release", (draft) => {
    if (draft.holder === executionId) draft.holder = null;
  });
}
