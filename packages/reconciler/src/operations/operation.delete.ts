import { ResourceNotFoundError } from "@notation/resource";
import {
  type DeleteResourceParams,
  type StepRunner,
  emitLifecycleEvent,
  getErrorDetails,
} from "./operation.types";
import { runPendingOperation } from "./operation.pending";
import { findResourceKey } from "./operation.read";

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
    if (params.creatingParams) {
      const skip = yield* findCreatedResource(
        step,
        params,
        params.creatingParams,
      );
      if (skip) {
        yield* emitLifecycleEvent(params, "delete", "skip", { reason: skip });
        yield* params.remove();
        yield* emitLifecycleEvent(params, "delete", "success");
        return;
      }
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
            params.deletion,
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

/**
 * Finds the key of the resource of a "creating" record, so that it can be
 * deleted. A class with `find` gets the key from `find`, with the record's
 * params. Any other class uses the key that the record holds.
 *
 * Returns the reason to remove only the record, or undefined to delete.
 */
async function* findCreatedResource(
  step: StepRunner,
  params: DeleteResourceParams,
  creatingParams: Record<string, unknown>,
): AsyncGenerator<unknown, string | undefined, unknown> {
  const { resource } = params;
  if (resource.find) {
    const key = yield* step.run("delete:find", () =>
      findResourceKey(resource, creatingParams),
    );
    if (!key) return "not-created";
    resource.setOutput({ ...resource.output, ...key });
  }
  return Object.values(resource.key).some((v) => v === undefined)
    ? "key-unknown"
    : undefined;
}
