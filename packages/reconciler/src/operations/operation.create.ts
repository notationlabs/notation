import {
  ResourceAlreadyExistsError,
  ResourceCreationUnknownError,
  ResourceNotFoundError,
  ResourceOperationPendingError,
  assertComputedFields,
  assertRequiredOutputs,
  changedKeys,
  deployLookup,
  diffParams,
  resolveOutputRefs,
  validateValues,
  type BaseResource,
  type DurableObject,
  type ResourceOperationContext,
} from "@notation/resource";
import { isCreatingRecord, type StateNode } from "@notation/state";
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
import {
  findResourceKey,
  readRemoteOperation,
  readResourceOperation,
} from "./operation.read";
import { firstDeferredError } from "./deferred-checks";

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
 * "creating" record, so that a later deploy can tell that this one tried.
 *
 * A resource that already exists is taken over: it is read and recorded with
 * the params the read returned. The result has `reclaimed: true`, and the
 * caller compares the record with the desired params, as for any recorded
 * resource. There are three ways to a takeover:
 * 1. The record is a "creating" record that an earlier deploy left, and
 *    `find` finds the resource. This runs before the create, so that a
 *    resource whose key the provider assigns is not made a second time.
 * 2. The create attempt's outcome was unknown, and its lookup found the
 *    resource.
 * 3. The provider reports that the resource already exists.
 *
 * Two rules limit a takeover:
 * 1. The create of a replacement does not keep the resource it replaces as
 *    the replacement. See `refuseReplaced` and `hasReplacedKey`.
 * 2. A resource whose key the provider assigns is taken over only through
 *    `find`, which matches on a unique attribute. See `existingKey`.
 *
 * When create fails and its outcome is not unknown, the record that this
 * create started from is written back, or the record is cleared if it
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

  const { resource, resourceParams } = params;
  try {
    if (isCreatingRecord(params.prior) && resource.find) {
      const key = yield* step.run("create:find", () =>
        findResourceKey(resource, resourceParams),
      );
      if (key) return yield* takeOver(step, params, key);
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
      if (!ResourceAlreadyExistsError.is(error)) {
        if (!isOutcomeUnknown(error)) yield* restoreRecord(params);
        throw error;
      }
      const key = yield* existingKey(step, params, error);
      if (hasReplacedKey(params, key)) yield* refuseReplaced(params);
      return yield* takeOver(step, params, key);
    }

    if (created.lookedUp && resource.read) {
      return yield* takeOver(step, params, created.key ?? {});
    }

    const computedPrimaryKey = created.key;
    resource.setOutput(resourceParams);
    if (computedPrimaryKey) {
      resource.setOutput({ ...computedPrimaryKey, ...resource.output });
    }

    // The create result is checked before the read, because the read uses
    // its key. When a check fails, the resource still exists, so it is
    // recorded with the outputs known at that point.
    const deferredError = yield* firstDeferredError([
      async function* () {
        if (!computedPrimaryKey) return;
        assertComputedFields(resource, computedPrimaryKey);
        await validateValues(resource, computedPrimaryKey, "create");
      },
      async function* () {
        const readResult = yield* readResourceOperation(step, {
          resource,
          resourceParams,
          persistedOutput: params.persistedOutput,
          emit: params.emit,
          maxOperationAttempts: params.maxOperationAttempts,
        });
        resource.setOutput({ ...resource.output, ...readResult });
      },
      async function* () {
        assertRequiredOutputs(resource, resource.output);
      },
    ]);

    yield* params.persist(
      resourceRecord(params, {
        lastOperation: "create",
        params: resource.toState(resourceParams),
        output: resource.toState(resource.output),
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

/**
 * Returns the part of the key that params do not supply, for a resource
 * that the provider reported as already existing. A class with `find` gets
 * it from `find`. A class without `find` has its whole key in params, unless
 * the provider assigns the key.
 *
 * The create fails when the resource cannot be told apart from others: the
 * provider assigns the key and the class has no `find`, or `find` finds no
 * resource. `find` itself fails when several resources match.
 */
async function* existingKey(
  step: StepRunner,
  params: CreateResourceParams,
  error: ResourceAlreadyExistsError,
): AsyncGenerator<unknown, DurableObject, unknown> {
  const { resource, resourceParams } = params;
  let reason: string;
  if (resource.find) {
    const key = yield* step.run("create:existing", () =>
      findResourceKey(resource, resourceParams),
    );
    if (key) return key;
    reason = "find did not find the resource";
  } else if (hasComputedPrimaryKey(resource)) {
    reason =
      `the provider assigns its key, and ${resource.type} has no find ` +
      `operation to look the key up`;
  } else {
    return {};
  }
  yield* restoreRecord(params);
  throw new ResourceAlreadyExistsError(
    `Cannot create ${resource.id}: ${error.message}. Deploy cannot take ` +
      `over the existing resource, because ${reason}.`,
    { cause: error },
  );
}

/**
 * Takes over the existing resource that has `key` and the key fields in
 * params: reads it, and records it with the params the read returned.
 */
async function* takeOver(
  step: StepRunner,
  params: CreateResourceParams,
  key: DurableObject,
): AsyncGenerator<unknown, { reclaimed: boolean }, unknown> {
  const { resource, resourceParams } = params;
  if (!resource.read) {
    throw new Error(
      `Cannot take over ${resource.id}: ${resource.type} has no read ` +
        `operation, so its params cannot be compared with config.`,
    );
  }
  resource.setOutput({ ...resourceParams, ...key });
  const { output, remote } = yield* readRemoteOperation(
    step.scope("create:reclaim"),
    {
      resource,
      resourceParams,
      emit: params.emit,
      maxOperationAttempts: params.maxOperationAttempts,
    },
  );

  resource.setOutput({ ...key, ...output });
  yield* params.persist(
    resourceRecord(params, {
      lastOperation: "create",
      params: resource.toState(
        observedParams(resource, remote ?? {}, resourceParams, {
          // The resource may be the replaced one, which differs from config
          // in a param that replaces it. So no param is assumed to match.
          assumeUnread: !hasReplacedKey(params, key),
        }),
      ),
      output: resource.toState(resource.output),
    }),
    "reclaimed",
  );
  yield* emitLifecycleEvent(params, "create", "success", {
    reason: "reclaimed",
  });
  return { reclaimed: true };
}

/**
 * True in the create of a replacement when the existing resource has the key
 * of the resource it replaces. The existing resource is then the replaced
 * one, if its delete has not taken effect, or the replacement, if a create
 * with an unknown outcome made it.
 */
function hasReplacedKey(
  params: CreateResourceParams,
  key: DurableObject,
): boolean {
  const { resource, resourceParams, replaces } = params;
  if (!replaces) return false;
  const existing = resource.keyOf({ ...resourceParams, ...key });
  return changedKeys(existing, resource.keyOf(replaces.output)).length === 0;
}

/**
 * Fails the create of a replacement that the provider refused because the
 * replaced resource still exists. The create made nothing, so a takeover
 * would keep the replaced resource as the replacement.
 *
 * The record of the replaced resource is written back, so the next deploy
 * replaces the resource again.
 */
async function* refuseReplaced(
  params: CreateResourceParams,
): AsyncGenerator<unknown, never, unknown> {
  yield* restoreRecord(params, params.replaces);
  throw new ResourceAlreadyExistsError(
    `Cannot create the replacement of ${params.resource.id}: the resource ` +
      `that it replaces still exists after its delete. Deploy does not ` +
      `take it over as the replacement. The next deploy deletes it and ` +
      `creates the replacement again.`,
  );
}

/**
 * Writes back `record`, which defaults to the record that the create started
 * from. Clears the record if there is none.
 */
async function* restoreRecord(
  params: CreateResourceParams,
  record: StateNode | undefined = params.prior,
): AsyncGenerator<unknown, void, unknown> {
  if (!record) {
    yield* params.persist(null, "restored");
    return;
  }
  const { version: _, ...fields } = record;
  yield* params.persist(
    {
      ...fields,
      group: fields.group ?? null,
      dependsOn: fields.dependsOn ?? params.dependsOn,
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

/**
 * The record written before the create is attempted. Its output holds the
 * key fields that params supply, so that the resource can be read or deleted
 * from the record alone.
 *
 * It keeps the output of the record that the create started from too. After
 * a drift read reported the resource gone, that output holds the key that
 * the provider assigned. If the create's outcome stays unknown, a delete of
 * this record then still has that key. A class with no `find` has no other
 * way to get it.
 */
function creatingRecord(params: CreateResourceParams): PersistedResourceState {
  const { resource, resourceParams, prior } = params;
  return resourceRecord(params, {
    lastOperation: "creating",
    params: resource.toState(resourceParams),
    output: resource.toState({
      ...(prior?.output as Record<string, unknown> | undefined),
      ...definedKey(resource, resourceParams),
    }),
  });
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
 * The params to record for a resource that create took over: the desired
 * params, each with the value that the read returned.
 *
 * A param that the read did not return is left out, so the comparison with
 * config that follows updates it. With `assumeUnread`, it keeps its desired
 * value instead when a difference in it would replace the resource, because
 * a replace needs evidence that the param differs.
 */
function observedParams(
  resource: BaseResource,
  remote: Record<string, unknown>,
  desired: Record<string, unknown>,
  { assumeUnread }: { assumeUnread: boolean },
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
  // The resource was read by its key, so a key param matches.
  const kept = new Set(
    assumeUnread
      ? replaceFields.map((field) => field.name)
      : Object.keys(resource.keyOf({})),
  );
  const leftOut = new Set(changed.filter((name) => !kept.has(name)));
  return Object.fromEntries(
    set
      .filter(([name]) => !leftOut.has(name))
      .map(([name, value]) => [name, remote[name] ?? value]),
  );
}

function resourceRecord(
  params: CreateResourceParams,
  fields: Pick<PersistedResourceState, "lastOperation" | "params" | "output">,
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
 * answers with a takeover, and `ResourceOperationPendingError`, which proves
 * that the attempt made nothing and sends the caller to the next attempt.
 *
 * Each attempt has its own effect ID, because a pending attempt fails its
 * effect and the next attempt calls create again with a new callback
 * context.
 */
async function* createAttempt(
  step: StepRunner,
  params: CreateResourceParams,
  attempt: number,
  context: ResourceOperationContext | undefined,
): AsyncGenerator<unknown, CreateAttemptResult, any> {
  const { resource, resourceParams } = params;
  const lookup = getLookupFunction(resource, resourceParams);

  return yield* step.effect(`create:remote:effect:${attempt}`, {
    effectId: createEffectId(params.executionId, resource.id, attempt),
    operation: `notation:create:${resource.type}`,
    input: (context
      ? { params: resourceParams, context }
      : { params: resourceParams }) as DurableObject,
    retryIn: CREATE_LOOKUP_RETRY_MS,
    maxAttempts: Math.min(
      params.maxOperationAttempts ?? DEFAULT_MAX_OPERATION_ATTEMPTS,
      MAX_CREATE_LOOKUP_ATTEMPTS,
    ),
    lookup: async () => (lookup ? lookup() : { status: "not-found" }),
    perform: async (): Promise<CreateAttemptResult> => {
      const key = await resource.create(resourceParams, context);
      return { key: key ? resource.toResult(key) : undefined };
    },
    failsOn: (error) =>
      lookup === undefined || !ResourceCreationUnknownError.is(error),
  });
}

function createEffectId(
  executionId: string,
  resourceId: string,
  attempt: number,
): string {
  return [
    "notation:create",
    encodeURIComponent(executionId),
    encodeURIComponent(resourceId),
    attempt,
  ].join(":");
}

/**
 * Returns the effect's lookup for a resource's create:
 * 1. With `find`, it calls `find`.
 * 2. With `read` and a key made only of params, it reads that key.
 * 3. Otherwise there is no lookup, so an unknown outcome stays unknown.
 */
function getLookupFunction(
  resource: BaseResource,
  resourceParams: Record<string, unknown>,
): (() => Promise<EffectLookup<CreateAttemptResult>>) | undefined {
  const { find, read } = resource;
  const settled = (key?: DurableObject) =>
    ({ status: "settled", result: { key, lookedUp: true } }) as const;
  if (find) {
    return async () => {
      const key = await findResourceKey(resource, resourceParams);
      return key ? settled(key) : { status: "not-found" };
    };
  }
  if (read && !hasComputedPrimaryKey(resource)) {
    return async () => {
      try {
        await read(resource.keyOf(resourceParams));
      } catch (error) {
        if (ResourceNotFoundError.is(error)) return { status: "not-found" };
        // A pending read reports a resource that exists and has not finished.
        // A throttled read doesn't, so the lookup throws and runs again later.
        if (!ResourceOperationPendingError.is(error) || error.throttled) {
          throw error;
        }
      }
      return settled();
    };
  }
  return undefined;
}

function hasComputedPrimaryKey(resource: BaseResource) {
  return Object.values(resource.schema).some(
    (item) => item.propertyType === "computed" && item.primaryKey,
  );
}
