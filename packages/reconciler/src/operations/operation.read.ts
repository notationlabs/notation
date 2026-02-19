import { createWorkflow } from "yieldstar";
import {
  DEFAULT_READ_POLL_OPTIONS,
  type ReadResourceParams,
  type StepRunner,
  emitLifecycleEvent,
  getErrorDetails,
} from "./operation.types";

type ReadRetryCondition = {
  key: string;
  reason: string;
  value?: unknown;
};

function needsReadRetry(
  readResult: Record<string, unknown>,
  retryConditions: ReadonlyArray<ReadRetryCondition>,
) {
  return retryConditions.find((condition) => {
    const resultValue = readResult[condition.key];
    if (condition.value !== undefined) {
      return resultValue !== condition.value;
    }

    return !resultValue;
  });
}

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

    let remoteOutput: Record<string, unknown> = {};
    const retryConditions = (params.resource.retryReadOnCondition ?? []).filter(
      Boolean,
    ) as ReadRetryCondition[];

    if (retryConditions.length > 0) {
      yield* step.poll(
        "read:poll-until-settled",
        params.readPollOptions ?? DEFAULT_READ_POLL_OPTIONS,
        async () => {
          remoteOutput = await params.resource.read!(params.resource.key);
          return !needsReadRetry(remoteOutput, retryConditions);
        },
      );
    } else {
      remoteOutput = yield* step.run("read:remote", () =>
        params.resource.read!(params.resource.key),
      );
    }

    const mergedOutput = {
      ...resourceParams,
      ...remoteOutput,
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
