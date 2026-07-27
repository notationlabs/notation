import { createWorkflow } from "yieldstar";
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
  await emitLifecycleEvent(params, "read", "start");

  if (params.dryRun) {
    await emitLifecycleEvent(params, "read", "dry-run");
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

      await emitLifecycleEvent(params, "read", "skip", {
        reason: "read-not-implemented",
      });
      await emitLifecycleEvent(params, "read", "success");
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

    await emitLifecycleEvent(params, "read", "success");
    return mergedOutput;
  } catch (err) {
    await emitLifecycleEvent(params, "read", "error", getErrorDetails(err));
    throw err;
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
