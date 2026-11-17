import {
  isCredentialMarker,
  ResourceNotFoundError,
  ResourceOperationPendingError,
  validateValues,
  type BaseResource,
  type DurableObject,
} from "@notation/resource";
import {
  decideDriftAction,
  type DriftRead,
  type ResourceAction,
} from "../plan";
import {
  type ResolvedResourceParams,
  type StepRunner,
  emitLifecycleEvent,
  emitErrorEvent,
} from "./operation.types";
import { runPendingOperation } from "./operation.pending";
import { omitCredentials } from "../credentials";

export type ReadOptions = {
  /**
   * Reads again after this many milliseconds when the read throws a
   * `ResourceNotFoundError`, up to `maxOperationAttempts` reads.
   */
  retryNotFoundMs?: number;
};

export async function* readResourceOperation(
  step: StepRunner,
  params: ResolvedResourceParams,
  options?: ReadOptions,
): AsyncGenerator<unknown, Record<string, unknown>, unknown> {
  return (yield* readRemoteOperation(step, params, options)).output;
}

/**
 * Reads the resource. `output` is the read merged over the desired params.
 * `remote` holds only what the read returned. It is undefined in a dry run,
 * and for a class with no read.
 */
export async function* readRemoteOperation(
  step: StepRunner,
  params: ResolvedResourceParams,
  options?: ReadOptions,
): AsyncGenerator<
  unknown,
  { output: Record<string, unknown>; remote?: Record<string, unknown> },
  unknown
> {
  yield* emitLifecycleEvent(params, "read", "start");

  if (params.dryRun) {
    yield* emitLifecycleEvent(params, "read", "dry-run");
    return { output: {} };
  }

  try {
    if (!params.resource.read) {
      const merged = params.persistedOutput
        ? { ...params.persistedOutput, ...params.resourceParams }
        : params.resourceParams;

      yield* emitLifecycleEvent(params, "read", "skip", {
        reason: "read-not-implemented",
      });
      return { output: merged as Record<string, unknown> };
    }

    const remote = yield* runPendingOperation(
      step,
      "read:remote",
      async (context) => {
        try {
          // The step records what this returns, and state records the read.
          return omitCredentials(
            params.resource,
            params.resource.toResult(
              await params.resource.read!(
                params.resource.key,
                context,
                params.resourceParams,
              ),
            ),
          );
        } catch (error) {
          const retryAfterMs = options?.retryNotFoundMs;
          if (retryAfterMs === undefined || !ResourceNotFoundError.is(error)) {
            throw error;
          }
          throw new ResourceOperationPendingError(error.message, {
            cause: error,
            retryAfterMs,
            callbackContext: context,
          });
        }
      },
      params.maxOperationAttempts,
    );
    // RFC 0009 will keep a resource whose read is malformed as it is. Until
    // then the read fails, so that a malformed read is never compared with
    // params, where it could plan a replacement.
    // A read can return the credential markers of the params it received,
    // for the part of a param that the remote still holds.
    if (remote) {
      await validateValues(params.resource, remote, "read", isCredentialMarker);
    }

    const mergedOutput = {
      ...params.resourceParams,
      ...remote,
    };

    yield* emitLifecycleEvent(params, "read", "success");
    return { output: mergedOutput, remote: remote ?? undefined };
  } catch (err) {
    yield* emitErrorEvent(params, "read", err);
    throw err;
  }
}

/**
 * Calls the resource's `find`, and returns the key it found, or null when it
 * found no resource.
 */
export async function findResourceKey(
  resource: BaseResource,
  resourceParams: Record<string, unknown>,
): Promise<DurableObject | null> {
  try {
    return resource.toResult(await resource.find!(resourceParams));
  } catch (error) {
    if (ResourceNotFoundError.is(error)) return null;
    throw error;
  }
}

/**
 * Reads the remote to compare it against persisted state. An absent resource
 * is a fact about the world rather than a failure, so it is reported as such;
 * every other error still propagates.
 */
export async function* readDriftOperation(
  step: StepRunner,
  params: ResolvedResourceParams,
): AsyncGenerator<unknown, DriftRead, unknown> {
  try {
    const output = yield* readResourceOperation(step, params);
    return { kind: "present", output };
  } catch (error) {
    if (ResourceNotFoundError.is(error)) return { kind: "absent" };
    throw error;
  }
}

/**
 * The drift gate, shared by every driver: a noop is only trusted once the
 * remote has been read back, because the provider may have drifted from
 * persisted state, which upgrades the decision. A resource with no read has
 * no remote to compare, so its noop stands. `driftDetection` defaults to on
 * here and nowhere else. Any other decision passes through untouched.
 */
export async function* applyDriftDetection(
  step: StepRunner,
  params: ResolvedResourceParams & {
    action: ResourceAction;
    driftDetection?: boolean;
  },
): AsyncGenerator<unknown, ResourceAction, unknown> {
  const { action, driftDetection, ...readParams } = params;
  if (
    action.decision !== "noop" ||
    !(driftDetection ?? true) ||
    !readParams.resource.read
  ) {
    return action;
  }

  const driftRead = yield* readDriftOperation(step, readParams);
  return decideDriftAction({
    resource: readParams.resource,
    params: readParams.resourceParams,
    driftRead,
  });
}
