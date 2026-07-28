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
    yield* runPendingOperation(
      step,
      "update:remote",
      (context) =>
        params.resource.update!(
          params.resource.key,
          params.patch,
          params.resourceParams,
          params.resource.toState(params.resource.output),
          context,
        ),
      params.maxOperationAttempts,
    );

    params.resource.setOutput({
      ...params.resource.key,
      ...params.resourceParams,
    });

    const readResult = yield* readResourceOperation(step, {
      resource: params.resource,
      resourceParams: params.resourceParams,
      persistedOutput: params.persistedOutput,
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
      params: params.resource.toState(params.resourceParams),
      output: params.resource.toState(params.resource.output),
    });

    yield* emitLifecycleEvent(params, "update", "success");
  } catch (err) {
    yield* emitLifecycleEvent(params, "update", "error", getErrorDetails(err));
    throw err;
  }
}
