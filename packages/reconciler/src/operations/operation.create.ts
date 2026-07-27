import { RetryableError, createWorkflow } from "yieldstar";
import { RetryableResourceError } from "@notation/resource";
import {
  DEFAULT_RETRY_OPTIONS,
  type CreateResourceParams,
  type StepRunner,
  emitLifecycleEvent,
  getErrorDetails,
} from "./operation.types";
import { readResourceOperation } from "./operation.read";

export async function* createResourceOperation(
  step: StepRunner,
  params: CreateResourceParams,
): AsyncGenerator<unknown, void, unknown> {
  await emitLifecycleEvent(params, "create", "start");

  if (params.dryRun) {
    await emitLifecycleEvent(params, "create", "dry-run");
    return;
  }

  try {
    const resourceParams = yield* step.run("create:get-params", () =>
      params.resource.getParams(),
    );

    const computedPrimaryKey = yield* step.run("create:remote", async () => {
      try {
        return await params.resource.create(resourceParams);
      } catch (err) {
        if (err instanceof RetryableResourceError) {
          throw new RetryableError(err.message, {
            ...(params.retryOptions ?? DEFAULT_RETRY_OPTIONS),
          });
        }
        throw err;
      }
    });

    params.resource.setOutput(resourceParams);
    if (computedPrimaryKey) {
      params.resource.setOutput({
        ...computedPrimaryKey,
        ...params.resource.output,
      });
    }

    const readResult = yield* readResourceOperation(step, {
      resource: params.resource,
      state: params.state,
      emit: params.emit,
      readPollOptions: params.readPollOptions,
      retryAbsent: true,
    });

    if (readResult.status !== "found") {
      throw new Error(
        "Post-create read completed without finding the resource",
      );
    }
    params.resource.setOutput({
      ...params.resource.output,
      ...readResult.output,
    });

    yield* step.run("create:persist-state", async () => {
      await params.state.update(params.resource.id, params.expectedRev, {
        id: params.resource.id,
        groupId: params.resource.groupId,
        groupType: params.resource.groupType,
        type: params.resource.type,
        lastOperation: "create",
        lastOperationAt: new Date().toISOString(),
        config: params.resource.config,
        params: params.resource.toState(resourceParams),
        output: params.resource.toState(params.resource.output),
      });
    });

    await emitLifecycleEvent(params, "create", "success");
  } catch (err) {
    await emitLifecycleEvent(params, "create", "error", getErrorDetails(err));
    throw err;
  }
}

export const createResourceWorkflow: unknown = createWorkflow(
  async function* (step, event) {
    return yield* createResourceOperation(
      step as StepRunner,
      event.params as CreateResourceParams,
    );
  },
);
