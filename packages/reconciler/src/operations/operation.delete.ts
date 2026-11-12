import { ResourceNotFoundError } from "@notation/resource";
import { proveOwnership } from "./ownership";
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
    if (params.creating) {
      const skip = yield* findCreatedResource(step, params, params.creating);
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
 * Decides whether the resource of a "creating" record is deleted. Deploy
 * deletes it only with proof that one of Notation's creates made it, which
 * `proveOwnership` checks with the record's params and executions:
 * 1. With `ownership: "token"`, a match sets the resource's output to the
 *    key `find` returned. Without one there is nothing to delete.
 * 2. With `ownership: "parent"`, it deletes by the key that `find` returned,
 *    or that the record holds. The record proves ownership, so `find` runs
 *    only for a key that the provider assigns. A record whose key the
 *    provider assigns holds no key.
 * 3. Otherwise nothing proves that the resource is Notation's.
 *
 * Returns the reason to remove only the record, or undefined to delete.
 */
async function* findCreatedResource(
  step: StepRunner,
  params: DeleteResourceParams,
  creating: NonNullable<DeleteResourceParams["creating"]>,
): AsyncGenerator<unknown, string | undefined, unknown> {
  const { resource } = params;
  if (resource.ownership === undefined) return "ownership-unproven";
  const proof = yield* step.run("delete:find", () =>
    proveOwnership(
      resource,
      creating.params,
      creating.creates,
      creating.creates.length > 0,
    ),
  );
  if (!proof) return "not-created";
  resource.setOutput({ ...resource.output, ...proof.key });
  return Object.values(resource.key).some((v) => v === undefined)
    ? "key-unknown"
    : undefined;
}
