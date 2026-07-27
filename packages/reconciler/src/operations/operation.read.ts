import { ResourceNotFoundError } from "@notation/resource";
import { createWorkflow } from "yieldstar";
import type { DriftRead } from "../plan";
import {
  type ReadResourceParams,
  type StepRunner,
  emitLifecycleEvent,
  getErrorDetails,
} from "./operation.types";
import { runPendingOperation } from "./operation.pending";

export async function* readResourceOperation(
  step: StepRunner,
  params: ReadResourceParams,
): AsyncGenerator<unknown, Record<string, unknown>, unknown> {
  yield* emitLifecycleEvent(params, "read", "start");

  if (params.dryRun) {
    yield* emitLifecycleEvent(params, "read", "dry-run");
    return {};
  }

  try {
    const resourceParams = yield* step.run("read:get-params", () =>
      params.resource.getParams(),
    );

    if (!params.resource.read) {
      const stateNode = yield* step.run("read:get-state-node", () =>
        params.state.get(params.resource.id),
      );
      const merged = stateNode
        ? { ...stateNode.output, ...resourceParams }
        : resourceParams;

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
      ...resourceParams,
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
  params: ReadResourceParams,
): AsyncGenerator<unknown, DriftRead, unknown> {
  try {
    const output = yield* readResourceOperation(step, params);
    return { kind: "present", output };
  } catch (error) {
    if (ResourceNotFoundError.is(error)) return { kind: "absent" };
    throw error;
  }
}

export const readResourceWorkflow: unknown = createWorkflow(
  async function* (step, event) {
    return yield* readResourceOperation(
      step as StepRunner,
      event.params as ReadResourceParams,
    );
  },
);
