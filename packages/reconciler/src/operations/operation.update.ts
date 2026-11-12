import {
  assertRequiredOutputs,
  deployLookup,
  resolveOutputRefs,
  type DurableObject,
} from "@notation/resource";
import {
  type StepRunner,
  type UpdateResourceParams,
  emitLifecycleEvent,
  getErrorDetails,
} from "./operation.types";
import { runPendingOperation } from "./operation.pending";
import { readResourceOperation } from "./operation.read";
import { firstDeferredError } from "./deferred-checks";

export async function* updateResourceOperation(
  step: StepRunner,
  params: UpdateResourceParams,
): AsyncGenerator<unknown, void, unknown> {
  yield* emitLifecycleEvent(params, "update", "start");

  if (params.dryRun) {
    yield* emitLifecycleEvent(params, "update", "dry-run");
    return;
  }

  try {
    // A resource with no update is replaced on any change, so the decision
    // never routes it here; skipping would drop the change silently.
    if (!params.resource.update) {
      throw new Error(`${params.resource.type} has no update operation`);
    }

    yield* runPendingOperation(
      step,
      "update:remote",
      (context) =>
        params.resource.update!(
          params.resource.key,
          params.patch,
          params.resourceParams,
          params.resource.toState(params.resource.output),
          context,
        ),
      params.maxOperationAttempts,
    );

    // An update starts from the computed outputs in state, because the read
    // may not return some of them, such as a value that only the create
    // returns. Params are left out, so that a param removed from the
    // declaration is not kept from state.
    const persistedComputedOutputs = Object.fromEntries(
      Object.entries(params.persistedOutput ?? {}).filter(
        ([field]) => params.resource.schema[field]?.propertyType === "computed",
      ),
    );
    params.resource.setOutput({
      ...persistedComputedOutputs,
      ...params.resource.key,
      ...params.resourceParams,
    });

    // When a check fails, the update was still made, so it is recorded with
    // the outputs known at that point.
    const deferredError = yield* firstDeferredError([
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

    yield* params.persist({
      id: params.resource.id,
      group: params.resource.group,
      type: params.resource.type,
      provider: params.resource.provider,
      lastOperation: "update",
      lastOperationAt: new Date().toISOString(),
      // State records the real outputs in place of output refs.
      config: resolveOutputRefs(
        params.resource.config,
        deployLookup,
      ) as DurableObject,
      params: params.resource.toState(params.resourceParams),
      output: params.resource.toState(params.resource.output),
      dependsOn: params.dependsOn,
    });
    // Thrown only once the record is written, so that state still records
    // the update.
    if (deferredError) throw deferredError;

    yield* emitLifecycleEvent(params, "update", "success");
  } catch (err) {
    yield* emitLifecycleEvent(params, "update", "error", getErrorDetails(err));
    throw err;
  }
}
