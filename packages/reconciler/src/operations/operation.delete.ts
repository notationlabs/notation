import { createWorkflow } from "yieldstar";
import {
  type DeleteResourceParams,
  type StepRunner,
  emitLifecycleEvent,
  getErrorDetails,
} from "./operation.types";
import { runPendingOperation } from "./operation.pending";

export async function* deleteResourceOperation(
  step: StepRunner,
  params: DeleteResourceParams,
): AsyncGenerator<unknown, void, unknown> {
  yield* emitLifecycleEvent(params, "delete", "start");

  if (params.dryRun) {
    yield* emitLifecycleEvent(params, "delete", "dry-run");
    return;
  }

  try {
    yield* runPendingOperation(
      step,
      "delete:remote",
      (context) =>
        params.resource.delete(
          params.resource.key,
          params.resource.toState(params.resource.output),
          context,
        ),
      params.maxOperationAttempts,
    );

    yield* params.remove();

    yield* emitLifecycleEvent(params, "delete", "success");
  } catch (err) {
    yield* emitLifecycleEvent(params, "delete", "error", getErrorDetails(err));
    throw err;
  }
}

export const deleteResourceWorkflow: unknown = createWorkflow(
  async function* (step, event) {
    return yield* deleteResourceOperation(
      step as StepRunner,
      event.params as DeleteResourceParams,
    );
  },
);
