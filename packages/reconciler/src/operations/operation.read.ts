import {
  ResourceNotFoundError,
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
  getErrorDetails,
} from "./operation.types";
import { runPendingOperation } from "./operation.pending";

export async function* readResourceOperation(
  step: StepRunner,
  params: ResolvedResourceParams,
): AsyncGenerator<unknown, Record<string, unknown>, unknown> {
  return (yield* readRemoteOperation(step, params)).output;
}

/**
 * Reads the resource. `output` is the read merged over the desired params.
 * `remote` holds only what the read returned. It is undefined in a dry run,
 * and for a class with no read.
 */
export async function* readRemoteOperation(
  step: StepRunner,
  params: ResolvedResourceParams,
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
      yield* emitLifecycleEvent(params, "read", "success");
      return { output: merged as Record<string, unknown> };
    }

    const remote = yield* runPendingOperation(
      step,
      "read:remote",
      async (context) =>
        params.resource.toResult(
          await params.resource.read!(params.resource.key, context),
        ),
      params.maxOperationAttempts,
    );
    // RFC 0009 will keep a resource whose read is malformed as it is. Until
    // then the read fails, so that a malformed read is never compared with
    // params, where it could plan a replacement.
    if (remote) await validateValues(params.resource, remote, "read");

    const mergedOutput = {
      ...params.resourceParams,
      ...remote,
    };

    yield* emitLifecycleEvent(params, "read", "success");
    return { output: mergedOutput, remote: remote ?? undefined };
  } catch (err) {
    yield* emitLifecycleEvent(params, "read", "error", getErrorDetails(err));
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
    const key = await resource.find!(resourceParams);
    return key ? resource.toResult(key) : {};
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
