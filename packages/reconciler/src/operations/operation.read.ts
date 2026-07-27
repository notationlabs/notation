import { RetryableError, createWorkflow } from "yieldstar";
import { ResourceNotReadyError } from "@notation/resource";
import {
  DEFAULT_READ_POLL_OPTIONS,
  type ReadResourceParams,
  type StepRunner,
  emitLifecycleEvent,
  getErrorDetails,
} from "./operation.types";

export async function* readResourceOperation(
  step: StepRunner,
  params: ReadResourceParams,
): AsyncGenerator<unknown, Record<string, unknown> | undefined, unknown> {
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

    const remote = yield* step.run("read:remote", async () => {
      try {
        const output = await params.resource.read!(params.resource.key);

        if (output === undefined && params.retryAbsent) {
          throw new RetryableError("Waiting for resource to become visible", {
            ...(params.readPollOptions ?? DEFAULT_READ_POLL_OPTIONS),
          });
        }

        // Absence is `null` rather than `undefined` so that it survives the
        // step's JSON round-trip when the run is replayed.
        return output ?? null;
      } catch (err) {
        // A tagged not-ready condition is the provider telling us to wait.
        // Everything else is a genuine failure and must surface.
        if (params.retryNotReady !== false && ResourceNotReadyError.is(err)) {
          throw new RetryableError(err.message, {
            ...(params.readPollOptions ?? DEFAULT_READ_POLL_OPTIONS),
          });
        }
        throw err;
      }
    });

    if (remote === null) {
      await emitLifecycleEvent(params, "read", "skip", {
        reason: "resource-absent",
      });
      return undefined;
    }

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
