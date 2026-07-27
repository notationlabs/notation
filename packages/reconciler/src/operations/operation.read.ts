import { RetryableError, createWorkflow } from "yieldstar";
import {
  DEFAULT_READ_POLL_OPTIONS,
  type ReadResourceParams,
  type StepRunner,
  emitLifecycleEvent,
  getErrorDetails,
} from "./operation.types";

export type SettledResourceReadResult =
  { status: "found"; output: Record<string, unknown> } | { status: "absent" };

export async function* readResourceOperation(
  step: StepRunner,
  params: ReadResourceParams,
): AsyncGenerator<unknown, SettledResourceReadResult, unknown> {
  await emitLifecycleEvent(params, "read", "start");

  if (params.dryRun) {
    await emitLifecycleEvent(params, "read", "dry-run");
    return { status: "found", output: {} };
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
      return {
        status: "found",
        output: merged as Record<string, unknown>,
      };
    }

    const remote = yield* step.run("read:remote", async () => {
      const result = await params.resource.read!(params.resource.key);
      if (result.status === "pending") {
        throw new RetryableError(result.reason, {
          ...(params.readPollOptions ?? DEFAULT_READ_POLL_OPTIONS),
        });
      }
      if (result.status === "absent" && params.retryAbsent) {
        throw new RetryableError("Waiting for resource to become visible", {
          ...(params.readPollOptions ?? DEFAULT_READ_POLL_OPTIONS),
        });
      }
      return result;
    });

    if (remote.status === "absent") {
      await emitLifecycleEvent(params, "read", "skip", {
        reason: "resource-absent",
      });
      return remote;
    }

    const mergedOutput = {
      ...resourceParams,
      ...remote.output,
    };

    await emitLifecycleEvent(params, "read", "success");
    return { status: "found", output: mergedOutput };
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
