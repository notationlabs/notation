import {
  ResourceNotFoundError,
  ResourceOperationPendingError,
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
import {
  DEFAULT_MAX_OPERATION_ATTEMPTS,
  retryPending,
} from "./operation.pending";
import { readResourceOperation } from "./operation.read";

/** How long yieldstar waits before it looks up an uncertain create again. */
const CREATE_LOOKUP_RETRY_MS = 1_000;

/**
 * The most attempts one create attempt's effect may end uncertain. It is
 * capped below `maxOperationAttempts`, because the pending loop runs up to
 * that many create attempts, and each would otherwise multiply it.
 */
const MAX_CREATE_LOOKUP_ATTEMPTS = 10;

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
 * Runs one create attempt as an effect, so a create whose outcome is unknown
 * is looked up before it runs again. The outcome is unknown when the process
 * stops before the attempt is recorded, or when create throws an error that
 * the resource reports as uncertain. Every other error fails the attempt,
 * including `ResourceOperationPendingError`, which proves that the attempt
 * made nothing and sends the caller to the next attempt.
 *
 * Each attempt has its own effect ID, because a pending attempt fails its
 * effect and the next attempt calls create again with a new callback context.
 */
async function* createAttempt(
  step: StepRunner,
  params: CreateResourceParams,
  attempt: number,
  context: ResourceOperationContext | undefined,
): AsyncGenerator<unknown, DurableObject | undefined, any> {
  const { resource, resourceParams } = params;
  const lookUp = createdLookup(resource);
  const uncertain = (error: unknown) =>
    lookUp !== undefined &&
    !ResourceOperationPendingError.is(error) &&
    resource.isUncertainError?.(error) === true;

  return yield* step.effect(`create:remote:effect:${attempt}`, {
    effectId: [
      "notation:create",
      encodeURIComponent(params.executionId),
      encodeURIComponent(resource.id),
      attempt,
    ].join(":"),
    operation: `notation:create:${resource.type}`,
    input: (context
      ? { params: resourceParams, context }
      : { params: resourceParams }) as DurableObject,
    retryIn: CREATE_LOOKUP_RETRY_MS,
    maxAttempts: Math.min(
      params.maxOperationAttempts ?? DEFAULT_MAX_OPERATION_ATTEMPTS,
      MAX_CREATE_LOOKUP_ATTEMPTS,
    ),
    lookup: (effectId) =>
      lookUp ? lookUp(resourceParams, effectId) : notFound(),
    perform: async (effectId) => {
      const key = await resource.create(resourceParams, context, effectId);
      return key ? resource.toResult(key) : undefined;
    },
    failsOn: (error) => !uncertain(error),
  });
}

type CreatedLookup = (
  resourceParams: Record<string, unknown>,
  token: string,
) => Promise<EffectLookup<DurableObject | undefined>>;

/**
 * Chooses how to find the resource that a create attempt made, or returns
 * undefined when it cannot be found. A resource with `findCreated` searches
 * by the attempt's token. A resource whose key is all params is read by that
 * key. A resource whose key the provider assigns, with no `findCreated`,
 * cannot be found.
 */
function createdLookup(resource: BaseResource): CreatedLookup | undefined {
  if (resource.findCreated) {
    const findCreated = resource.findCreated;
    return async (resourceParams, token) => {
      try {
        const key = await findCreated(resourceParams, token);
        return {
          status: "settled",
          result: key ? resource.toResult(key) : undefined,
        };
      } catch (error) {
        if (ResourceNotFoundError.is(error)) return { status: "not-found" };
        throw error;
      }
    };
  }

  if (resource.read && !hasComputedPrimaryKey(resource)) {
    const read = resource.read;
    return async (resourceParams) => {
      try {
        await read(resource.keyOf(resourceParams));
        return { status: "settled", result: undefined };
      } catch (error) {
        if (ResourceNotFoundError.is(error)) return { status: "not-found" };
        // A pending read reports a resource that exists and has not finished.
        if (ResourceOperationPendingError.is(error)) {
          return { status: "settled", result: undefined };
        }
        throw error;
      }
    };
  }

  return undefined;
}

async function notFound(): Promise<EffectLookup<never>> {
  return { status: "not-found" };
}

function hasComputedPrimaryKey(resource: BaseResource) {
  return Object.values(resource.schema).some(
    (item) => item.propertyType === "computed" && item.primaryKey,
  );
}
