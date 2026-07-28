import { ResourceNotFoundError } from "@notation/resource";
import { decideDriftAction, type DriftRead, type ResourceAction } from "../plan";
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
  yield* emitLifecycleEvent(params, "read", "start");

  if (params.dryRun) {
    yield* emitLifecycleEvent(params, "read", "dry-run");
    return {};
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
      return merged as Record<string, unknown>;
    }

    const remote = yield* runPendingOperation(
      step,
      "read:remote",
      (context) => params.resource.read!(params.resource.key, context),
      params.maxOperationAttempts,
    );

    const mergedOutput = {
      ...params.resourceParams,
      ...remote,
    };

    yield* emitLifecycleEvent(params, "read", "success");
    return mergedOutput;
  } catch (err) {
    yield* emitLifecycleEvent(params, "read", "error", getErrorDetails(err));
    throw err;
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
