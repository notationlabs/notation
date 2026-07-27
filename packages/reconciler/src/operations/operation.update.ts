import { RetryableError, createWorkflow } from "yieldstar";
import { RetryableResourceError } from "@notation/resource";
import {
  DEFAULT_RETRY_OPTIONS,
  type StepRunner,
  type UpdateResourceParams,
  emitLifecycleEvent,
  getErrorDetails,
} from "./operation.types";
import { readResourceOperation } from "./operation.read";

export async function* updateResourceOperation(
  step: StepRunner,
  params: UpdateResourceParams,
): AsyncGenerator<unknown, void, unknown> {
  await emitLifecycleEvent(params, "update", "start");

  if (params.dryRun) {
    await emitLifecycleEvent(params, "update", "dry-run");
    return;
  }

  if (!params.resource.update) {
    await emitLifecycleEvent(params, "update", "skip", {
      reason: "update-not-implemented",
    });
    await emitLifecycleEvent(params, "update", "success");
    return;
  }

  try {
    const resourceParams = yield* step.run("update:get-params", () =>
      params.resource.getParams(),
    );

    yield* step.run("update:remote", async () => {
      try {
        await params.resource.update!(
          params.resource.key,
          params.patch,
          resourceParams,
          params.resource.toState(params.resource.output),
        );
      } catch (err) {
        if (err instanceof RetryableResourceError) {
          throw new RetryableError(err.message, {
            ...(params.retryOptions ?? DEFAULT_RETRY_OPTIONS),
          });
        }
        throw err;
      }
    });

    params.resource.setOutput({
      ...params.resource.key,
      ...resourceParams,
    });

    const readResult = yield* readResourceOperation(step, {
      resource: params.resource,
      state: params.state,
      emit: params.emit,
      readPollOptions: params.readPollOptions,
      retryAbsent: true,
    });

    if (readResult.status !== "found") {
      throw new Error(
        "Post-update read completed without finding the resource",
      );
    }
    params.resource.setOutput({
      ...params.resource.output,
      ...readResult.output,
    });

    yield* step.run("update:persist-state", async () => {
      await params.state.update(params.resource.id, params.expectedRev, {
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
    });

    await emitLifecycleEvent(params, "update", "success");
  } catch (err) {
    await emitLifecycleEvent(params, "update", "error", getErrorDetails(err));
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
