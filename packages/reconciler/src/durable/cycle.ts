import {
  changedKeys,
  diffParams,
  validateParams,
  type BaseResource,
} from "@notation/resource";
import type { StateNode } from "@notation/state";
import {
  ResourceCycleError,
  listIds,
  placeholderParamsBlocker,
  revertedDependents,
  type DeployUnit,
} from "../cycles";
import { readDriftOperation, updateResourceOperation } from "../operations";
import { getDependencyIds, type ResourceAction } from "../plan";
import { assertSameType } from "../resource-type";
import {
  openStateSession,
  reconcileResource,
  type ReconcileOptions,
} from "./reconcile";
import { durableEmitter, scopeStep, type DurableStepRunner } from "./step";
import type { DurableDeployOptions, DurableWorkflowOptions } from "./types";
import type { DurableStep } from "./sdk";

const CREATING_DECISIONS: ResourceAction["decision"][] = [
  "create",
  "drift-recreate",
  "replace",
  "drift-replace",
];

/**
 * Deploys the members of a cycle in passes:
 *
 * 1. The first pass goes through the members in order. A placeholder with no
 *    record is created with its placeholder params. A placeholder with a
 *    record is left as it is, unless drift detection finds that it no
 *    longer exists, and then it is created with its placeholder params.
 *    Every other member is reconciled as usual.
 * 2. Each later pass reconciles every member with its full params. A pass in
 *    which no member's output changes ends the deploy of the cycle.
 *
 * A cycle gets one pass after the first for each member, and at least two,
 * so that a member that refers to itself is updated and then checked. When
 * outputs still change in the last pass, deploy fails and names those
 * outputs. A dry run stops after the first pass, as it creates and updates
 * nothing. It also reconciles each placeholder that the first pass left as
 * it is with its full params, so that it reports the update that deploy
 * would make.
 */
export async function* reconcileCycle(
  step: DurableStep,
  cycle: DeployUnit,
  opts: DurableDeployOptions,
): AsyncGenerator<any, void, any> {
  const scope = (resource: BaseResource, suffix?: string, stateKey?: string) =>
    scopeStep(
      step,
      `notation:deploy:${encodeURIComponent(resource.id)}${suffix ? `:${suffix}` : ""}`,
      stateKey,
    );
  const members = new Set(cycle.members);
  // A second create in one execution would reuse the create effect IDs of
  // the first, so it would not run.
  const created = new Set<BaseResource>();
  const replaced: BaseResource[] = [];
  const options = (resource: BaseResource): ReconcileOptions => ({
    onDecision: (decision) => {
      if (!CREATING_DECISIONS.includes(decision)) return;
      if (created.has(resource)) {
        throw recreateError(cycle, resource, decision, replaced);
      }
      created.add(resource);
    },
    beforeReplace: async function* () {
      replaced.push(resource);
      // The scope has no pass number: the guard above allows at most one
      // replace of each member in one execution.
      const revertStep = scope(resource, "revert");
      const from = new Set([resource]);
      // Every revert is prepared before the first one runs, so that a
      // revert that can't be computed fails the deploy before any resource
      // has lost its contributions.
      const reverts = [];
      for (const dependent of revertedDependents(
        opts.resources,
        cycle,
        resource,
      )) {
        const revert = yield* prepareRevert(
          revertStep.scope(encodeURIComponent(dependent.id)),
          dependent,
          opts,
          from,
          resource,
        );
        if (revert) reverts.push(revert);
      }
      for (const revert of reverts) yield* revert();
    },
  });

  const kept: BaseResource[] = [];
  for (const resource of cycle.members) {
    if (!cycle.placeholders.includes(resource)) {
      yield* reconcileResource(
        scope(resource),
        resource,
        opts,
        options(resource),
      );
      continue;
    }
    const placeholderStep = scope(resource, "placeholder");
    const record = yield* checkPlaceholder(
      placeholderStep.scope("check"),
      resource,
      opts,
    );
    if (record === "present") {
      kept.push(resource);
      continue;
    }
    yield* reconcileResource(placeholderStep, resource, opts, {
      ...options(resource),
      excludeContributionsFrom: members,
      placeholder: true,
      recreate: record === "absent",
    });
  }
  if (opts.dryRun) {
    for (const resource of kept) {
      yield* reconcileResource(
        scope(resource, "settle:1", "settle:1"),
        resource,
        opts,
        options(resource),
      );
    }
    return;
  }

  const passes = Math.max(2, cycle.members.length);
  let changed: string[] = [];
  for (let pass = 1; pass <= passes; pass += 1) {
    changed = [];
    for (const resource of cycle.members) {
      // This loop's first pass is the first time that deploy reconciles a
      // placeholder with its full params, so its noop is announced then. A
      // placeholder that this deploy did not create is checked for drift
      // then too.
      const first = pass === 1 && cycle.placeholders.includes(resource);
      const detectDrift = first && !created.has(resource);
      const before = resource.output as Record<string, unknown> | null;
      yield* reconcileResource(
        scope(resource, `settle:${pass}`, `settle:${pass}`),
        resource,
        detectDrift ? opts : { ...opts, driftDetection: false },
        { ...options(resource), quietNoop: !first },
      );
      changed.push(...changedOutputs(resource, before));
    }
    if (changed.length === 0) return;
  }

  throw new ResourceCycleError(
    `The cycle of ${listIds(cycle.members)} did not settle after ${passes + 1} passes. These outputs changed in the last pass: ${changed.join(", ")}. When a member takes an output of another member, take a value that stays the same across updates, such as a name, in place of one that changes on every update, such as a version ID.`,
  );
}

/**
 * Loads the record of a placeholder and its output. A placeholder with a
 * record is "present", unless drift detection reads it and finds it gone,
 * and then it is "absent". The cycle's members that come after it refer to
 * it, so it must exist before they are reconciled. Without drift detection,
 * or without a read, the record is trusted.
 */
async function* checkPlaceholder(
  step: DurableStepRunner,
  resource: BaseResource,
  opts: DurableDeployOptions,
): AsyncGenerator<any, "none" | "present" | "absent", any> {
  const session = yield* openStateSession(step, opts, resource);
  // Repeats the notation:validate check, because validate ran before the
  // hold and the record may have changed since.
  assertSameType(resource, session.node);
  if (!session.node) return "none";
  resource.setOutput(session.node.output);
  if (!(opts.driftDetection ?? true) || !resource.read) return "present";
  return (yield* isGone(step, opts, resource, session.node))
    ? "absent"
    : "present";
}

async function* isGone(
  step: DurableStepRunner,
  opts: DurableDeployOptions,
  resource: BaseResource,
  node: StateNode,
): AsyncGenerator<any, boolean, any> {
  const readStep = step.scope("read");
  const read = yield* readDriftOperation(readStep, {
    resource,
    resourceParams: node.params,
    persistedOutput: node.output,
    // No dryRun: a dry run suppresses mutations, not reads.
    emit: durableEmitter(readStep, opts.emit),
    maxOperationAttempts: opts.maxOperationAttempts,
  });
  return read.kind === "absent";
}

/**
 * Updates `resource` without the contributions that depend on one of
 * `peers`, so that it no longer refers to them. Destroy does this for each
 * placeholder before it deletes a cycle.
 */
export async function* revertToPlaceholder(
  parent: DurableStepRunner,
  resource: BaseResource,
  opts: DurableWorkflowOptions,
  peers: ReadonlySet<BaseResource>,
): AsyncGenerator<any, void, any> {
  const revert = yield* prepareRevert(parent, resource, opts, peers);
  if (revert) yield* revert();
}

/**
 * Computes the update that leaves out the contributions of `resource` that
 * depend on one of `peers`, and returns a function that runs it. Deploy
 * prepares these before it replaces `replaced`, and destroy for each
 * placeholder, with no `replaced`. Returns undefined when there is nothing
 * to update: the resource has no record, its record has another type, or
 * the params would not change.
 *
 * The params start from the record. The params that those contributions set
 * and the hidden params take their values from the current code, as state
 * holds neither as they would be without the contributions. So the revert
 * needs the current code to resolve: it reads the outputs of the other
 * dependencies from their records. A contribution that depends on a
 * resource with no record was not deployed, so it is left out too. A
 * dependency outside contributions that has no record fails the revert.
 * The record keeps only the edges that remain.
 */
async function* prepareRevert(
  parent: DurableStepRunner,
  resource: BaseResource,
  opts: DurableWorkflowOptions,
  peers: ReadonlySet<BaseResource>,
  replaced?: BaseResource,
): AsyncGenerator<
  any,
  (() => AsyncGenerator<any, void, any>) | undefined,
  any
> {
  const revertKey = replaced
    ? `revert:${encodeURIComponent(replaced.id)}`
    : "revert";
  const step = parent.scope("revert", revertKey);
  const session = yield* openStateSession(step, opts, resource);
  const node = session.node;
  if (!node || node.type !== resource.type) return undefined;
  resource.setOutput(node.output);

  const fixed = new Set(resource.getFixedDependencies());
  const excluded = new Set(peers);
  const missing = resource
    .getDependencies()
    .filter(
      (dependency) =>
        (fixed.has(dependency) || !excluded.has(dependency)) &&
        dependency.output == null,
    );
  if (missing.length > 0) {
    const records = yield* step.run("dependency-outputs", () =>
      Promise.all(missing.map((dependency) => opts.state.get(dependency.id))),
    );
    for (const [index, dependency] of missing.entries()) {
      const record = records[index];
      if (record && record.type === dependency.type) {
        dependency.setOutput(record.output);
      } else if (fixed.has(dependency)) {
        const others = listIds([...peers].filter((peer) => peer !== resource));
        throw new ResourceCycleError(
          `Cannot update ${resource.id} without its contributions that refer to ${others}: its dependency ${dependency.id} ${record ? `has a state record of type ${record.type}, not ${dependency.type}` : "has no state record"}, so its output is not known. The revert takes the dependencies of ${resource.id} from the current code. Undo the change to them since the last deploy, or deploy them first.`,
        );
      } else {
        excluded.add(dependency);
      }
    }
  }
  if (excluded.size > peers.size) {
    const blocker = placeholderParamsBlocker(resource, excluded);
    if (blocker) {
      throw new ResourceCycleError(
        `Cannot update ${resource.id} without its contributions that refer to resources with no state record: ${blocker}. Deploy those resources first.`,
      );
    }
  }
  // A peer that is only in contributions is left out of the params, so its
  // output is not needed, and the record no longer depends on it.
  const remaining = resource
    .getDependencies()
    .filter((dependency) => fixed.has(dependency) || !excluded.has(dependency));

  const placeholder = yield* step.run("params", () =>
    resource.getParams({ excludeContributionsFrom: excluded }),
  );
  const params: Record<string, unknown> = { ...node.params };
  for (const [key, item] of Object.entries(resource.schema)) {
    // State does not hold hidden params.
    if (item.hidden) params[key] = placeholder[key];
  }
  // These params neither are required nor force a replacement: the cycle's
  // placeholders are checked for that when deploy and destroy order the
  // resources, `revertedDependents` checks the others, and the check above
  // covers the contributions that depend on resources with no record.
  for (const key of resource.getContributedParams({ from: excluded })) {
    params[key] = placeholder[key];
  }
  await validateParams(resource, params, "deploy");
  const { patch } = diffParams(resource.schema, node.params, params, {
    canUpdate: true,
  });
  if (Object.keys(patch).length === 0) return undefined;

  const emit = durableEmitter(step, opts.emit);
  return async function* () {
    yield* updateResourceOperation(step, {
      resource,
      resourceParams: params,
      persistedOutput: node.output,
      patch,
      dependsOn: getDependencyIds(resource, remaining),
      dryRun: opts.dryRun,
      emit: (event) =>
        emit({
          ...event,
          reason: "cycle-revert",
          ...(replaced ? { replacedDependency: replaced.id } : {}),
        }),
      maxOperationAttempts: opts.maxOperationAttempts,
      persist: session.persist,
    });
  };
}

/**
 * The error for a member that deploy would create or replace a second time
 * while its cycle settles.
 */
function recreateError(
  cycle: DeployUnit,
  resource: BaseResource,
  decision: ResourceAction["decision"],
  replaced: BaseResource[],
): ResourceCycleError {
  const others = listIds(cycle.members.filter((member) => member !== resource));
  if (decision === "replace" || decision === "drift-replace") {
    return new ResourceCycleError(
      `${resource.id} would be replaced while its cycle with ${others} settles, after this deploy created it. A param of ${resource.id} that forces a replacement takes a value from an output of another member of the cycle, and that output changed when the member was updated with its contributions. Take the param from an output that stays the same, such as a name.`,
    );
  }
  const cascaded = replaced.filter((member) => member !== resource);
  const when =
    cascaded.length > 0
      ? `, when deploy replaced ${listIds(cascaded)} and deleted the resources that block that delete`
      : "";
  return new ResourceCycleError(
    `${resource.id} would be created again while its cycle with ${others} settles. This deploy created it, and its record was deleted again${when}. Deploy can create a resource only once in one deploy. Deploy again to create ${resource.id}.`,
  );
}

/**
 * The outputs of `resource` that differ from `before`, as `<id>.<key>`. Both
 * sides are compared as state records them, as an output loaded from state
 * has no hidden fields.
 */
function changedOutputs(
  resource: BaseResource,
  before: Record<string, unknown> | null,
): string[] {
  return changedKeys(
    before ? resource.toState(before) : {},
    resource.output ? resource.toState(resource.output) : {},
  ).map((key) => `${resource.id}.${key}`);
}
