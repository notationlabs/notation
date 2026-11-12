import {
  ResourceAlreadyExistsError,
  ResourceCreationUnknownError,
  ResourceNotFoundError,
  ResourceOperationPendingError,
  assertComputedFields,
  assertRequiredOutputs,
  deployLookup,
  diffParams,
  resolveOutputRefs,
  validateValues,
  type BaseResource,
  type DurableObject,
  type ResourceOperationContext,
} from "@notation/resource";
import { isCreatingRecord } from "@notation/state";
import { WorkflowEffectError, type EffectLookup } from "@notation/durable";
import {
  type CreateResourceParams,
  type PersistedResourceState,
  type StepRunner,
  emitLifecycleEvent,
  getErrorDetails,
} from "./operation.types";
import {
  DEFAULT_MAX_OPERATION_ATTEMPTS,
  retryPending,
} from "./operation.pending";
import { readRemoteOperation, readResourceOperation } from "./operation.read";
import { firstDeferredError } from "./deferred-checks";
import {
  createToken,
  hasComputedPrimaryKey,
  proveOwnership,
  type OwnershipProof,
} from "./ownership";

/** How long @notation/durable waits before it looks up a create with an unknown outcome again. */
const CREATE_LOOKUP_RETRY_MS = 1_000;

/**
 * The most attempts one create attempt's effect may end unknown. It is
 * capped below `maxOperationAttempts`, because the pending loop runs up to
 * that many create attempts, and each would otherwise multiply it.
 */
const MAX_CREATE_LOOKUP_ATTEMPTS = 10;

/**
 * Creates the resource and records it. Before the create, it writes a
 * "creating" record that names this execution, so that a later execution
 * can tell that this one tried.
 *
 * A resource is taken over only with proof that one of Notation's creates
 * made it (see `BaseResource.ownership`). It is then read and recorded with
 * the params the read observed. The result has `reclaimed: true`, and the
 * caller compares the record with the desired params, as for any recorded
 * resource. There are three ways to a takeover:
 * 1. The record is a "creating" record, the class has `ownership: "token"`,
 *    and `find` finds the resource by the token of an earlier execution that
 *    the record names. This runs before the create, so that a resource whose
 *    key the provider assigns is not made a second time.
 * 2. The create attempt's outcome was unknown, and its lookup found the
 *    resource.
 * 3. The provider reports that the resource already exists, and the proof
 *    holds. Without the proof, create fails.
 *
 * When create fails and its outcome is not unknown, the record that this
 * execution started from is written back, or the record is cleared if it
 * started from none. An unknown outcome keeps the "creating" record.
 */
export async function* createResourceOperation(
  step: StepRunner,
  params: CreateResourceParams,
): AsyncGenerator<unknown, { reclaimed: boolean }, unknown> {
  yield* emitLifecycleEvent(params, "create", "start");

  if (params.dryRun) {
    yield* emitLifecycleEvent(params, "create", "dry-run");
    return { reclaimed: false };
  }

  try {
    const earlier = earlierExecutions(params);
    if (
      isCreatingRecord(params.prior) &&
      params.resource.ownership === "token" &&
      earlier.length > 0
    ) {
      const proof = yield* step.run("create:find", () =>
        proveOwnership(params.resource, params.resourceParams, earlier),
      );
      if (proof) return yield* reclaim(step, params, proof);
    }

    yield* params.persist(creatingRecord(params), "creating");

    let created: CreateAttemptResult;
    try {
      created = yield* retryPending(
        step,
        "create:remote",
        (attempt, context) => createAttempt(step, params, attempt, context),
        params.maxOperationAttempts,
      );
    } catch (error) {
      if (ResourceAlreadyExistsError.is(error)) {
        const proof =
          params.replacement && params.resource.ownership === "parent"
            ? null
            : yield* step.run("create:prove", () =>
                proveOwnership(params.resource, params.resourceParams, [
                  ...earlier,
                  params.executionId,
                ]),
              );
        if (proof) return yield* reclaim(step, params, proof);
        yield* restorePrior(params);
        throw new ResourceAlreadyExistsError(refusalMessage(params, error), {
          cause: error,
        });
      }
      if (!isOutcomeUnknown(error)) yield* restorePrior(params);
      throw error;
    }

    if (created.lookedUp && params.resource.read) {
      return yield* reclaim(step, params, {
        key: created.key ?? null,
        executionId: params.executionId,
      });
    }

    const computedPrimaryKey = created.key;
    params.resource.setOutput(params.resourceParams);
    if (computedPrimaryKey) {
      params.resource.setOutput({
        ...computedPrimaryKey,
        ...params.resource.output,
      });
    }

    // The create result is checked before the read, because the read uses
    // its key. When a check fails, the resource still exists, so it is
    // recorded with the outputs known at that point.
    const deferredError = yield* firstDeferredError([
      async function* () {
        if (!computedPrimaryKey) return;
        assertComputedFields(params.resource, computedPrimaryKey);
        await validateValues(params.resource, computedPrimaryKey, "create");
      },
      async function* () {
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
      },
      async function* () {
        assertRequiredOutputs(params.resource, params.resource.output);
      },
    ]);

    yield* params.persist(
      resourceRecord(params, {
        lastOperation: "create",
        params: params.resource.toState(params.resourceParams),
        output: params.resource.toState(params.resource.output),
        creates: [params.executionId],
      }),
    );
    // Thrown only once the record is written, so that state still tracks
    // the resource that create made.
    if (deferredError) throw deferredError;

    yield* emitLifecycleEvent(params, "create", "success");
    return { reclaimed: false };
  } catch (err) {
    yield* emitLifecycleEvent(params, "create", "error", getErrorDetails(err));
    throw err;
  }
}

async function* reclaim(
  step: StepRunner,
  params: CreateResourceParams,
  proof: OwnershipProof,
): AsyncGenerator<unknown, { reclaimed: boolean }, unknown> {
  yield* reclaimResource(step, params, proof);
  yield* emitLifecycleEvent(params, "create", "success", {
    reason: "reclaimed",
  });
  return { reclaimed: true };
}

/**
 * Writes back the record that the create started from, or clears the record
 * if it started from none. A "creating" record that an earlier execution
 * left keeps its `creates`, so a later deploy can still prove ownership by
 * the tokens of those executions.
 */
async function* restorePrior(
  params: CreateResourceParams,
): AsyncGenerator<unknown, void, unknown> {
  const { prior } = params;
  if (!prior) {
    yield* params.persist(null, "restored");
    return;
  }
  const { version: _, ...record } = prior;
  yield* params.persist(
    {
      ...record,
      group: record.group ?? null,
      dependsOn: record.dependsOn ?? params.dependsOn,
    } as PersistedResourceState,
    "restored",
  );
}

/**
 * True for an error after which the create may have made the resource:
 * `perform` ran, and neither it nor a lookup settled the outcome.
 */
function isOutcomeUnknown(error: unknown): boolean {
  return (
    ResourceCreationUnknownError.is(error) ||
    (error instanceof WorkflowEffectError &&
      error.code === "EFFECT_OUTCOME_UNKNOWN")
  );
}

function refusalMessage(
  params: CreateResourceParams,
  error: ResourceAlreadyExistsError,
): string {
  const { resource } = params;
  if (params.replacement) {
    return (
      `Cannot create the replacement of ${resource.id}: ${error.message}. ` +
      `Deploy deleted the resource that this one replaces, and does not ` +
      `take over another resource with the same key.`
    );
  }
  const reason =
    resource.ownership === undefined
      ? `${resource.type} cannot prove which create made a resource`
      : `nothing proves that one of Notation's creates made it`;
  return (
    `Cannot create ${resource.id}: ${error.message}. Deploy does not take ` +
    `over the existing resource, because ${reason}.`
  );
}

/**
 * The record written before the create is attempted. It names this
 * execution and the executions that `params.prior` names. Its output holds the key fields that params supply, so
 * that the resource can be read or deleted from the record alone. After a
 * drift read reported the resource gone, it keeps the recorded output too,
 * so that a key the provider assigned is not lost.
 */
function creatingRecord(params: CreateResourceParams): PersistedResourceState {
  const { resource, resourceParams, prior } = params;
  const key = definedKey(resource, resourceParams);
  return resourceRecord(params, {
    lastOperation: "creating",
    params: resource.toState(resourceParams),
    output: resource.toState(
      prior && !isCreatingRecord(prior) ? { ...prior.output, ...key } : key,
    ),
    creates: [...earlierExecutions(params), params.executionId],
  });
}

/**
 * The executions other than this one that `params.prior` names. A create
 * made under another key does not match, because `find` checks the desired
 * key as well as the token.
 */
function earlierExecutions(params: CreateResourceParams): string[] {
  return (params.prior?.creates ?? []).filter(
    (id) => id !== params.executionId,
  );
}

function definedKey(
  resource: BaseResource,
  values: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(resource.keyOf(values)).filter(
      ([, value]) => value !== undefined,
    ),
  );
}

/**
 * Reads a resource whose ownership `proof` established, and records it with
 * the params the read observed.
 */
async function* reclaimResource(
  step: StepRunner,
  params: CreateResourceParams,
  proof: OwnershipProof,
): AsyncGenerator<unknown, void, unknown> {
  const { resource, resourceParams } = params;
  if (!resource.read) {
    throw new Error(
      `Cannot take over ${resource.id}: ${resource.type} has no read ` +
        `operation, so its params cannot be compared with config.`,
    );
  }
  resource.setOutput({ ...resourceParams, ...proof.key });
  const { output, remote } = yield* readRemoteOperation(
    step.scope("create:reclaim"),
    {
      resource,
      resourceParams,
      emit: params.emit,
      maxOperationAttempts: params.maxOperationAttempts,
    },
  );

  resource.setOutput({ ...proof.key, ...output });
  yield* params.persist(
    resourceRecord(params, {
      lastOperation: "create",
      params: resource.toState(
        observedParams(resource, remote ?? {}, resourceParams),
      ),
      output: resource.toState(resource.output),
      ...(proof.executionId ? { creates: [proof.executionId] } : {}),
    }),
    "reclaimed",
  );
}

/**
 * The params to record for a resource that create took over: the desired
 * params, each with the value that the read returned.
 *
 * A param that the read did not return is left out, so the comparison with
 * config that follows updates it. It keeps its desired value instead when a
 * difference in it would replace the resource, because a replace needs
 * evidence that the param differs.
 */
function observedParams(
  resource: BaseResource,
  remote: Record<string, unknown>,
  desired: Record<string, unknown>,
): Record<string, unknown> {
  const set = Object.entries(desired).filter(
    ([, value]) => value !== undefined,
  );
  const unread = Object.fromEntries(
    set.filter(([name]) => remote[name] === undefined),
  );
  const { changed, replaceFields } = diffParams(resource.schema, {}, unread, {
    canUpdate: Boolean(resource.update),
  });
  const replacing = new Set(replaceFields.map((field) => field.name));
  const leftOut = new Set(changed.filter((name) => !replacing.has(name)));
  return Object.fromEntries(
    set
      .filter(([name]) => !leftOut.has(name))
      .map(([name, value]) => [name, remote[name] ?? value]),
  );
}

function resourceRecord(
  params: CreateResourceParams,
  fields: Pick<
    PersistedResourceState,
    "lastOperation" | "params" | "output" | "creates"
  >,
): PersistedResourceState {
  const { resource } = params;
  return {
    id: resource.id,
    group: resource.group,
    type: resource.type,
    provider: resource.provider,
    lastOperationAt: new Date().toISOString(),
    // State records the real outputs in place of output refs.
    config: resolveOutputRefs(resource.config, deployLookup) as DurableObject,
    dependsOn: params.dependsOn,
    ...fields,
  };
}

/**
 * `key` is what create, or the lookup, returned. `lookedUp` is set when the
 * lookup settled the attempt, so that create did not report what it made.
 */
type CreateAttemptResult = { key?: DurableObject; lookedUp?: true };

/**
 * Runs one create attempt as an effect, so a create whose outcome is unknown
 * is looked up before it runs again. The outcome is unknown when the process
 * stops before the attempt is recorded, or when create throws
 * `ResourceCreationUnknownError`. Every other error fails the attempt,
 * including `ResourceAlreadyExistsError`, which `createResourceOperation`
 * answers with a proof of ownership, and `ResourceOperationPendingError`,
 * which proves that the attempt made nothing and sends the caller to the
 * next attempt.
 *
 * Every attempt passes the execution's create token to create and to the
 * lookup. Each attempt has its own effect ID, because a pending attempt
 * fails its effect and the next attempt calls create again with a new
 * callback context.
 */
async function* createAttempt(
  step: StepRunner,
  params: CreateResourceParams,
  attempt: number,
  context: ResourceOperationContext | undefined,
): AsyncGenerator<unknown, CreateAttemptResult, any> {
  const { resource, resourceParams } = params;
  const token = createToken(params.executionId, resource.id);
  const lookup = getLookupFunction(resource, resourceParams);

  return yield* step.effect(`create:remote:effect:${attempt}`, {
    effectId: `${token}:${attempt}`,
    operation: `notation:create:${resource.type}`,
    input: (context
      ? { params: resourceParams, context }
      : { params: resourceParams }) as DurableObject,
    retryIn: CREATE_LOOKUP_RETRY_MS,
    maxAttempts: Math.min(
      params.maxOperationAttempts ?? DEFAULT_MAX_OPERATION_ATTEMPTS,
      MAX_CREATE_LOOKUP_ATTEMPTS,
    ),
    lookup: async () => (lookup ? lookup(token) : { status: "not-found" }),
    perform: async (): Promise<CreateAttemptResult> => {
      const key = await resource.create(resourceParams, context, token);
      return { key: key ? resource.toResult(key) : undefined };
    },
    failsOn: (error) =>
      lookup === undefined || !ResourceCreationUnknownError.is(error),
  });
}

/**
 * Returns the effect's lookup for a resource's create, or undefined when the
 * resource's class cannot prove that a resource it finds is Notation's:
 * 1. With `ownership: "token"`, `find` searches for the execution's token.
 * 2. With `ownership: "parent"` and `find`, `find` searches the parent.
 * 3. With `ownership: "parent"`, `read`, and a key made only of params, it
 *    reads that key.
 * 4. Otherwise there is no lookup, so an unknown outcome stays unknown.
 */
function getLookupFunction(
  resource: BaseResource,
  resourceParams: Record<string, unknown>,
) {
  const { find, read, ownership } = resource;
  if (ownership === undefined) return undefined;
  if (find) {
    return settledUnlessNotFound(async (token) => {
      const key = await find(resourceParams, token);
      return key ? resource.toResult(key) : undefined;
    });
  }
  if (ownership === "parent" && read && !hasComputedPrimaryKey(resource)) {
    return settledUnlessNotFound(async () => {
      try {
        await read(resource.keyOf(resourceParams));
      } catch (error) {
        // A pending read reports a resource that exists and has not finished.
        // A throttled read doesn't, so the lookup throws and runs again later.
        if (!ResourceOperationPendingError.is(error) || error.throttled) {
          throw error;
        }
      }
      return undefined;
    });
  }
  return undefined;
}

/** Wraps `lookup` in @notation/durable's lookup shape, reporting not-found on `ResourceNotFoundError`. */
function settledUnlessNotFound(
  lookup: (token: string) => Promise<DurableObject | undefined>,
) {
  return async (token: string): Promise<EffectLookup<CreateAttemptResult>> => {
    try {
      const key = await lookup(token);
      return { status: "settled", result: { key, lookedUp: true } };
    } catch (error) {
      if (ResourceNotFoundError.is(error)) return { status: "not-found" };
      throw error;
    }
  };
}
