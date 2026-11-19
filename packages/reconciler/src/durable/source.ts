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
  getCredentialVersion,
  holdCredential,
  recordSecretStrings,
} from "../credentials";
import { emitErrorEvent, emitLifecycleEvent } from "../operations";
import { getDependencyIds, hasSameEdges } from "../plan";
import { assertSameType } from "../resource-type";
import { prefetchedFor } from "../prefetch";
import { readAndDecideSource, sourceState } from "../sources";
import { openStateSession, sameGroup } from "./reconcile";
import { durableEmitter, type DurableStepRunner } from "./step";
import type { DeployContext } from "./types";

function sourceContext(
  opts: DeployContext,
  source: BaseCredentialSource,
): CredentialSourceContext {
  return {
    id: source.id,
    executionId: opts.executionId,
    app: opts.app,
    stage: opts.stage,
    ...prefetchedFor(opts.prefetched, source),
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

  const { decision, output } = yield* readAndDecideSource(
    step.scope("source-read"),
    (scope) => durableEmitter(scope, opts.emit),
    source,
    params,
    sourceContext(opts, source),
    record,
  );
  source.setOutput(output);
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
      !sameGroup(group, source.group));
  if (!opts.dryRun && (decision !== "noop" || rewrite)) {
    yield* session.persist({
      id: source.id,
      group: source.group,
      type: source.type,
      provider: source.provider,
      kind: "credential-source",
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
 * version of its credential, which does not change. Nothing records the
 * value. The source's output holds the params and the revision that deploy
 * reconciled it with, so a resumed deploy, which replays the reconcile, loads
 * the same value.
 */
export async function* loadSourceCredential(
  step: DurableStepRunner,
  opts: DeployContext,
  source: BaseCredentialSource,
): AsyncGenerator<any, void, any> {
  const name = "value";
  const version = getCredentialVersion(source, name);
  if (!opts.reconciled.has(source) || version === null) {
    throw new Error(
      `Cannot load the credential of ${source.id}: deploy has not reconciled the source`,
    );
  }
  const event = { resource: source, emit: durableEmitter(step, opts.emit) };
  yield* emitLifecycleEvent(event, "load", "start", { credential: name });
  try {
    const value = await source.loadCredential(
      sourceState(source, source.output as Record<string, unknown>),
      sourceContext(opts, source),
    );
    if (value === undefined) {
      throw new Error(
        `The load of ${source.id} (${source.type}) returned no value`,
      );
    }
    recordSecretStrings(value);
    await validateValues(source, { [name]: value }, "load");
    holdCredential(value, version);
  } catch (error) {
    const scrubbed = scrubError(error);
    yield* emitErrorEvent(event, "load", scrubbed, { credential: name });
    throw scrubbed;
  }
  yield* emitLifecycleEvent(event, "load", "success", { credential: name });
}
