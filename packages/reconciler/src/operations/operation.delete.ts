import { RetryableError, createWorkflow } from "yieldstar";
import {
  DEFAULT_RETRY_OPTIONS,
  type DeleteResourceParams,
  type StepRunner,
  emitLifecycleEvent,
  getErrorDetails,
  matchError,
} from "./operation.types";

export async function* deleteResourceOperation(
  step: StepRunner,
  params: DeleteResourceParams,
): AsyncGenerator<unknown, void, unknown> {
  await emitLifecycleEvent(params, "delete", "start");

  if (params.dryRun) {
    await emitLifecycleEvent(params, "delete", "dry-run");
    return;
  }

  try {
    try {
      yield* step.run("delete:remote", async () => {
        try {
          await params.resource.delete(
            params.resource.key,
            params.resource.toState(params.resource.output),
          );
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
    } catch (err) {
      const matcher = matchError(err, params.resource.notFoundOnError);
      if (matcher) {
        await emitLifecycleEvent(params, "delete", "skip", {
          reason: matcher.reason,
        });
      } else {
        throw err;
      }
    }

    yield* step.run("delete:persist-state", () =>
      params.state.delete(params.resource.id, params.expectedRev),
    );

    await emitLifecycleEvent(params, "delete", "success");
  } catch (err) {
    await emitLifecycleEvent(params, "delete", "error", getErrorDetails(err));
    throw err;
  }
}

export const deleteResourceWorkflow: unknown = createWorkflow(
  async function* (step, event) {
    return yield* deleteResourceOperation(
      step as StepRunner,
      event.params as DeleteResourceParams,
    );
  },
);
