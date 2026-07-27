import { createWorkflow } from "yieldstar";
import {
  type StepRunner,
  type UpdateResourceParams,
  emitLifecycleEvent,
  getErrorDetails,
} from "./operation.types";
import { runPendingOperation } from "./operation.pending";
import { readResourceOperation } from "./operation.read";

export async function* updateResourceOperation(
  step: StepRunner,
  params: UpdateResourceParams,
): AsyncGenerator<unknown, void, unknown> {
  yield* emitLifecycleEvent(params, "update", "start");

  if (params.dryRun) {
    yield* emitLifecycleEvent(params, "update", "dry-run");
    return;
  }

  if (!params.resource.update) {
    yield* emitLifecycleEvent(params, "update", "skip", {
      reason: "update-not-implemented",
    });
    yield* emitLifecycleEvent(params, "update", "success");
    return;
  }

  try {
    const resourceParams = yield* step.run("update:get-params", () =>
      params.resource.getParams(),
    );

    yield* runPendingOperation(
      step,
      "update:remote",
      (context) =>
        params.resource.update!(
          params.resource.key,
          params.patch,
          resourceParams,
          params.resource.toState(params.resource.output),
          context,
        ),
      params.maxOperationAttempts,
    );

    params.resource.setOutput({
      ...params.resource.key,
      ...resourceParams,
    });

    const readResult = yield* readResourceOperation(step, {
      resource: params.resource,
      state: params.state,
      emit: params.emit,
      maxOperationAttempts: params.maxOperationAttempts,
    });

    params.resource.setOutput({
      ...params.resource.output,
      ...readResult,
    });

    yield* params.persist({
      id: params.resource.id,
      groupId: params.resource.groupId,
      groupType: params.resource.groupType,
      type: params.resource.type,
      lastOperation: "update",
      lastOperationAt: new Date().toISOString(),
      config: params.resource.config,
      params: params.resource.toState(resourceParams),
      output: params.resource.toState(params.resource.output),
    });

    yield* emitLifecycleEvent(params, "update", "success");
  } catch (err) {
    yield* emitLifecycleEvent(params, "update", "error", getErrorDetails(err));
    throw err;
  }
}

export const updateResourceWorkflow: unknown = createWorkflow(
  async function* (step, event) {
    return yield* updateResourceOperation(
      step as StepRunner,
      event.params as UpdateResourceParams,
    );
  },
);
