import { RetryableError, createWorkflow } from "yieldstar";
import {
  DEFAULT_RETRY_OPTIONS,
  type CreateResourceParams,
  type StepRunner,
  emitLifecycleEvent,
  getErrorDetails,
  matchError,
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
        const matcher = matchError(err, params.resource.retryLaterOnError);
        if (matcher) {
          throw new RetryableError(matcher.reason, {
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
    });

    params.resource.setOutput({
      ...params.resource.output,
      ...readResult,
    });

    yield* step.run("create:persist-state", async () => {
      // expectedRev 0 asserts the record is still absent, so two first-time
      // deploys of the same resource cannot both persist.
      await params.state.update(
        params.resource.id,
        {
          id: params.resource.id,
          groupId: params.resource.groupId,
          groupType: params.resource.groupType,
          type: params.resource.type,
          lastOperation: "create",
          lastOperationAt: new Date().toISOString(),
          config: params.resource.config,
          params: params.resource.toState(resourceParams),
          output: params.resource.toState(params.resource.output),
        },
        params.expectedRev,
      );
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
