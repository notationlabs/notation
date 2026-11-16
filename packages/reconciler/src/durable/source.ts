import {
  deployLookup,
  resolveOutputRefs,
  validateParams,
  validateValues,
  type BaseCredentialSource,
  type CredentialSourceContext,
  type DurableObject,
  type ResourceGroupRef,
} from "@notation/resource";
import { isCreatingRecord } from "@notation/state";
import { scrubError } from "@notation/utils";
import {
  credentialVersion,
  holdCredential,
  recordSecretStrings,
} from "../credentials";
import { emitLifecycleEvent, getErrorDetails } from "../operations";
import { getDependencyIds, hasSameEdges } from "../plan";
import { assertSameType } from "../resource-type";
import {
  decideSource,
  readSource,
  sourceState,
  type SourceRead,
} from "../sources";
import { openStateSession } from "./reconcile";
import { durableEmitter, type DurableStepRunner } from "./step";
import type { DeployContext } from "./types";

// The params that each source was reconciled with in this process, for its
// `loadCredential`. A resumed deploy replays the reconcile, which sets them
// again.
const reconciledParams = new WeakMap<
  BaseCredentialSource,
  Record<string, unknown>
>();

function sourceContext(
  opts: DeployContext,
  source: BaseCredentialSource,
): CredentialSourceContext {
  return {
    id: source.id,
    executionId: opts.executionId,
    app: opts.nameScope.app,
    stage: opts.nameScope.stage,
  };
}

/**
 * Reconciles a source: reads its revision, and records its params and
 * outputs. A source with no record is created, and one whose params or
 * outputs changed is updated. Nothing is called at a provider but `read`.
 * `step` must already be scoped to the source.
 */
export async function* reconcileSource(
  step: DurableStepRunner,
  source: BaseCredentialSource,
  opts: DeployContext,
): AsyncGenerator<any, void, any> {
  const session = yield* openStateSession(step, opts, source);
  assertSameType(source, session.node);
  const record =
    session.node && !isCreatingRecord(session.node) ? session.node : undefined;

  const params = yield* step.run("params", () =>
    source.getParams({ recordedOutputs: opts.recordedOutputs }),
  );
  await validateParams(source, params, "deploy");
  const dependsOn = getDependencyIds(source);

  const readStep = step.scope("source-read");
  const event = { resource: source, emit: durableEmitter(readStep, opts.emit) };
  yield* emitLifecycleEvent(event, "read", "start");
  let read: SourceRead;
  try {
    // A step, so that a resumed deploy gets the same revision.
    read = (yield* readStep.run("read", async () => {
      try {
        return (await readSource(
          source,
          params,
          sourceContext(opts, source),
          record,
        )) as DurableObject;
      } catch (error) {
        throw scrubError(error);
      }
    })) as unknown as SourceRead;
  } catch (error) {
    yield* emitLifecycleEvent(event, "read", "error", getErrorDetails(error));
    throw error;
  }
  yield* emitLifecycleEvent(event, "read", "success");
  for (const [index, message] of read.warnings.entries()) {
    yield* durableEmitter(
      readStep.scope(`warning:${index}`),
      opts.emit,
    )({
      level: "warn",
      event: "reconciler.source.warning",
      resourceId: source.id,
      resourceType: source.type,
      message,
    });
  }

  const { decision, output } = decideSource(
    source,
    record,
    params,
    read.result,
  );
  source.setOutput(output);
  reconciledParams.set(source, params);
  yield* durableEmitter(
    step,
    opts.emit,
  )({
    level: "info",
    event: "reconciler.deploy.decision",
    resourceId: source.id,
    resourceType: source.type,
    decision,
  });

  const group = (record?.group ?? null) as ResourceGroupRef | null;
  const rewrite =
    record &&
    (!hasSameEdges(record, dependsOn) ||
      record.provider !== source.provider ||
      group?.type !== source.group?.type ||
      group?.id !== source.group?.id);
  if (!opts.dryRun && (decision !== "noop" || rewrite)) {
    yield* session.persist({
      id: source.id,
      group: source.group,
      type: source.type,
      provider: source.provider,
      lastOperation: decision === "create" ? "create" : "update",
      lastOperationAt: new Date().toISOString(),
      config: resolveOutputRefs(source.config, deployLookup) as DurableObject,
      params: source.toState(params),
      output: source.toState(output),
      dependsOn,
    });
  }
  opts.reconciled.add(source);
}

/**
 * Calls the source's `loadCredential`, and holds the value under the
 * credential's version, which does not change. Nothing records the value.
 */
export async function* loadSourceCredential(
  step: DurableStepRunner,
  opts: DeployContext,
  source: BaseCredentialSource,
  name: string,
): AsyncGenerator<any, void, any> {
  const params = reconciledParams.get(source);
  const version = credentialVersion(source, name);
  if (!params || version === null) {
    throw new Error(
      `Cannot load the credential ${name} of ${source.id}: deploy has not reconciled the source`,
    );
  }
  const event = { resource: source, emit: durableEmitter(step, opts.emit) };
  yield* emitLifecycleEvent(event, "load", "start", { credential: name });
  try {
    const loaded = await source.loadCredential(
      params,
      sourceState(source, source.output as Record<string, unknown>),
      sourceContext(opts, source),
    );
    const value = (loaded as Record<string, unknown> | undefined)?.[name];
    if (value === undefined) {
      throw new Error(
        `The load of ${source.id} (${source.type}) returned no ${name}`,
      );
    }
    recordSecretStrings(value);
    await validateValues(source, { [name]: value }, "load");
    holdCredential(value, version);
  } catch (error) {
    const scrubbed = scrubError(error);
    yield* emitLifecycleEvent(event, "load", "error", {
      credential: name,
      ...getErrorDetails(scrubbed),
    });
    throw scrubbed;
  }
  yield* emitLifecycleEvent(event, "load", "success", { credential: name });
}
