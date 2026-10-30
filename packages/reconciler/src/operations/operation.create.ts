import {
  ResourceCreationUnknownError,
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

/** How long yieldstar waits before it looks up a create with an unknown outcome again. */
const CREATE_LOOKUP_RETRY_MS = 1_000;

/**
 * The most attempts one create attempt's effect may end unknown. It is
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
 * stops before the attempt is recorded, or when create throws
 * `ResourceCreationUnknownError`. Every other error fails the attempt,
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
  const lookup = getLookupFunction(resource, resourceParams);

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
    lookup: lookup ?? (async () => ({ status: "not-found" })),
    perform: async (effectId) => {
      const key = await resource.create(resourceParams, context, effectId);
      return key ? resource.toResult(key) : undefined;
    },
    failsOn: (error) =>
      lookup === undefined || !ResourceCreationUnknownError.is(error),
  });
}

/**
 * Returns the effect's lookup for a resource's create, or undefined when the
 * resource cannot be found:
 * 1. With `find`, it searches for the attempt's token.
 * 2. With `read` and a key made only of params, it reads that key.
 * 3. Otherwise there is no lookup.
 */
function getLookupFunction(
  resource: BaseResource,
  resourceParams: Record<string, unknown>,
) {
  const find = resource.find;
  if (find) {
    return settledUnlessNotFound(async (token) => {
      const key = await find(resourceParams, token);
      return key ? resource.toResult(key) : undefined;
    });
  }

  const read = resource.read;
  if (read && !hasComputedPrimaryKey(resource)) {
    return settledUnlessNotFound(async () => {
      try {
        await read(resource.keyOf(resourceParams));
      } catch (error) {
        // A pending read reports a resource that exists and has not finished.
        if (!ResourceOperationPendingError.is(error)) throw error;
      }
      return undefined;
    });
  }

  return undefined;
}

/** Wraps `lookup` in yieldstar's lookup shape, reporting not-found on `ResourceNotFoundError`. */
function settledUnlessNotFound(
  lookup: (token: string) => Promise<DurableObject | undefined>,
) {
  return async (
    token: string,
  ): Promise<EffectLookup<DurableObject | undefined>> => {
    try {
      return { status: "settled", result: await lookup(token) };
    } catch (error) {
      if (ResourceNotFoundError.is(error)) return { status: "not-found" };
      throw error;
    }
  };
}

function hasComputedPrimaryKey(resource: BaseResource) {
  return Object.values(resource.schema).some(
    (item) => item.propertyType === "computed" && item.primaryKey,
  );
}
