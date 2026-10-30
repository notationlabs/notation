import {
  ResourceNotFoundError,
  type BaseResource,
  type DurableObject,
  type ResourceOperationContext,
} from "@notation/resource";
import type { EffectLookup } from "yieldstar";
import {
  type CreateResourceParams,
  type StepRunner,
  emitLifecycleEvent,
  getErrorDetails,
} from "./operation.types";
import { retryPending } from "./operation.pending";
import { readResourceOperation } from "./operation.read";

/**
 * The settled value of one create effect. A failed create is recorded rather
 * than thrown: yieldstar treats a thrown `perform` as uncertain and retries
 * it with no limit.
 */
type CreateOutcome = { result: DurableObject | undefined } | { error: Error };

/** How long yieldstar waits before it looks up an uncertain create again. */
const CREATE_LOOKUP_RETRY_MS = 1_000;

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
    const computedPrimaryKey = yield* retryPending(
      step,
      "create:remote",
      (attempt, context) => createAttempt(step, params, attempt, context),
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
      group: params.resource.group,
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

/**
 * Runs one create attempt as an effect. Each attempt has its own effect ID,
 * because a pending attempt settles its effect and the next attempt calls
 * create again with a new callback context. The next type is `any` because
 * yieldstar resumes an effect with its own step records.
 */
async function* createAttempt(
  step: StepRunner,
  params: CreateResourceParams,
  attempt: number,
  context: ResourceOperationContext | undefined,
): AsyncGenerator<unknown, DurableObject | undefined, any> {
  const { resource, resourceParams } = params;
  const outcome = yield* step.effect(`create:remote:effect:${attempt}`, {
    effectId: [
      "notation:create",
      encodeURIComponent(params.executionId),
      encodeURIComponent(resource.id),
      attempt,
    ].join(":"),
    operation: `notation:create:${resource.type}`,
    input: context
      ? { params: resourceParams, context }
      : { params: resourceParams },
    retryIn: CREATE_LOOKUP_RETRY_MS,
    lookup: () => lookUpCreated(resource, resourceParams),
    perform: async (): Promise<CreateOutcome> => {
      try {
        const key = await resource.create(resourceParams, context);
        return { result: key ? resource.toResult(key) : undefined };
      } catch (error) {
        return {
          error: error instanceof Error ? error : new Error(String(error)),
        };
      }
    },
  });

  if ("error" in outcome) throw outcome.error;
  return outcome.result;
}

/**
 * Reports whether a create interrupted by a crash made the resource. A
 * resource with no read, or whose provider assigns its primary key, cannot be
 * found from its params, so it is reported as not found and created again.
 * A read error other than `ResourceNotFoundError` leaves the outcome unknown,
 * and yieldstar looks again after `retryIn`.
 */
async function lookUpCreated(
  resource: BaseResource,
  resourceParams: DurableObject,
): Promise<EffectLookup<CreateOutcome>> {
  if (!resource.read || hasComputedPrimaryKey(resource)) {
    return { status: "not-found" };
  }
  // The resource's key is read from its output.
  resource.setOutput(resourceParams);
  try {
    const remote = await resource.read(resource.key);
    return { status: "settled", result: { result: resource.toResult(remote) } };
  } catch (error) {
    if (ResourceNotFoundError.is(error)) return { status: "not-found" };
    throw error;
  }
}

function hasComputedPrimaryKey(resource: BaseResource) {
  return Object.values(resource.schema).some(
    (item) => item.propertyType === "computed" && item.primaryKey,
  );
}
