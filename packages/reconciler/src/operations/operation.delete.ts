import { ResourceNotFoundError } from "@notation/resource";
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
    } catch (error) {
      // Absence is delete's goal state, so a delete that finds the resource
      // already gone — a crash-window replay, or an out-of-band removal —
      // has succeeded.
      if (!ResourceNotFoundError.is(error)) throw error;
    }

    yield* params.remove();

    yield* emitLifecycleEvent(params, "delete", "success");
  } catch (err) {
    yield* emitLifecycleEvent(params, "delete", "error", getErrorDetails(err));
    throw err;
  }
}
