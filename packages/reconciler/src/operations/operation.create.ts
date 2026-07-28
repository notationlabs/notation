import {
  type CreateResourceParams,
  type StepRunner,
  emitLifecycleEvent,
  getErrorDetails,
} from "./operation.types";
import { runPendingOperation } from "./operation.pending";
import { readResourceOperation } from "./operation.read";

export async function* createResourceOperation(
  step: StepRunner,
  params: CreateResourceParams,
): AsyncGenerator<unknown, void, unknown> {
  yield* emitLifecycleEvent(params, "create", "start");

  if (params.dryRun) {
    yield* emitLifecycleEvent(params, "create", "dry-run");
    return;
  }

  try {
    const computedPrimaryKey = yield* runPendingOperation(
      step,
      "create:remote",
      (context) => params.resource.create(params.resourceParams, context),
      params.maxOperationAttempts,
    );

    params.resource.setOutput(params.resourceParams);
    if (computedPrimaryKey) {
      params.resource.setOutput({
        ...computedPrimaryKey,
        ...params.resource.output,
      });
    }

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
      lastOperation: "create",
      lastOperationAt: new Date().toISOString(),
      config: params.resource.config,
      params: params.resource.toState(params.resourceParams),
      output: params.resource.toState(params.resource.output),
    });

    yield* emitLifecycleEvent(params, "create", "success");
  } catch (err) {
    yield* emitLifecycleEvent(params, "create", "error", getErrorDetails(err));
    throw err;
  }
}
