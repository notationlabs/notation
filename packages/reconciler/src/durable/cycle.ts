import { changedKeys, type BaseResource } from "@notation/resource";
import {
  ResourceCycleError,
  listIds,
  placeholderParamsBlocker,
  type DeployUnit,
} from "../cycles";
import { readDriftOperation } from "../operations";
import type { DriftRead, ResourceAction } from "../plan";
import { assertSameType } from "../resource-type";
import {
  openStateSession,
  reconcileResource,
  type ReconcileOptions,
} from "./reconcile";
import { durableEmitter, scopeStep, type DurableStepRunner } from "./step";
import type { DurableDeployOptions } from "./types";
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
 *    which no member's output changes, and after which no member lacks
 *    contributions because of a replacement, ends the deploy of the cycle.
 *
 * A cycle gets one pass after the first for each member, and at least two,
 * so that a member that refers to itself is updated and then checked. Each
 * replace of a member adds a pass. When
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
  // The passes after the first. A replace adds one.
  let passes = 0;
  // The members that a replacement created without the contributions that
  // refer to itself or to a member it deleted, and that the current pass has
  // not reconciled since. The pass doesn't end the deploy of the cycle while
  // one remains.
  const incomplete = new Set<BaseResource>();
  const options = (resource: BaseResource): ReconcileOptions => ({
    replaceWithout: (deleted) => {
      const without = replacedWithout(cycle, resource, deleted);
      if (without.size > 0) incomplete.add(resource);
      return without;
    },
    onDecision: (decision) => {
      if (!CREATING_DECISIONS.includes(decision)) return;
      if (created.has(resource)) {
        throw recreateError(cycle, resource, decision, replaced);
      }
      created.add(resource);
      if (decision === "replace" || decision === "drift-replace") {
        replaced.push(resource);
        // The replacement is created again, so the cycle gets one more pass
        // for it to settle in. The guard above allows one replace of each
        // member, so the number of passes stays bounded.
        passes += 1;
      }
    },
  });

  // The placeholders that the first pass left as they are, each with the
  // drift read of the first pass, if there was one.
  const kept = new Map<BaseResource, DriftRead | undefined>();
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
    const { recorded, driftRead } = yield* checkPlaceholder(
      placeholderStep.scope("check"),
      resource,
      opts,
    );
    if (recorded && driftRead?.kind !== "absent") {
      kept.set(resource, driftRead);
      continue;
    }
    yield* reconcileResource(placeholderStep, resource, opts, {
      ...options(resource),
      excludeContributionsFrom: members,
      driftRead,
    });
  }
  // Drift detection ran in the first pass for every member. For a kept
  // placeholder, the first reconcile with its full params decides drift from
  // the read of the first pass.
  const settleOpts = { ...opts, driftDetection: false };
  if (opts.dryRun) {
    for (const [resource, driftRead] of kept) {
      yield* reconcileResource(
        scope(resource, "settle:1", "settle:1"),
        resource,
        settleOpts,
        { ...options(resource), driftRead },
      );
    }
    return;
  }

  passes += Math.max(2, cycle.members.length);
  let changed: string[] = [];
  for (let pass = 1; pass <= passes; pass += 1) {
    changed = [];
    for (const resource of cycle.members) {
      // This reconcile applies the full params of the resource.
      incomplete.delete(resource);
      // This loop's first pass is the first time that deploy reconciles a
      // placeholder with its full params, so its noop is announced then.
      const first = pass === 1 && cycle.placeholders.includes(resource);
      const before = resource.output as Record<string, unknown> | null;
      yield* reconcileResource(
        scope(resource, `settle:${pass}`, `settle:${pass}`),
        resource,
        settleOpts,
        {
          ...options(resource),
          quietNoop: !first,
          driftRead: pass === 1 ? kept.get(resource) : undefined,
        },
      );
      changed.push(...changedOutputs(resource, before));
    }
    if (changed.length === 0 && incomplete.size === 0) return;
  }

  const incompleteText =
    incomplete.size > 0
      ? ` These members were left without some of their contributions in the last pass: ${listIds([...incomplete])}.`
      : "";
  throw new ResourceCycleError(
    `The cycle of ${listIds(cycle.members)} did not settle after ${passes + 1} passes. These outputs changed in the last pass: ${changed.join(", ") || "none"}.${incompleteText} When a member takes an output of another member, take a value that stays the same across updates, such as a name, in place of one that changes on every update, such as a version ID.`,
  );
}

/**
 * Loads the record of a placeholder and its output. With drift detection, it
 * also reads a placeholder that has a record. The cycle's members that come
 * after the placeholder refer to it, so deploy must know whether it still
 * exists before it reconciles them. Without drift detection, or without a
 * read, there is no `driftRead`, and the record is trusted.
 */
async function* checkPlaceholder(
  step: DurableStepRunner,
  resource: BaseResource,
  opts: DurableDeployOptions,
): AsyncGenerator<any, { recorded: boolean; driftRead?: DriftRead }, any> {
  const session = yield* openStateSession(step, opts, resource);
  // Repeats the notation:validate check, because validate ran before the
  // hold and the record may have changed since.
  assertSameType(resource, session.node);
  if (!session.node) return { recorded: false };
  resource.setOutput(session.node.output);
  if (!(opts.driftDetection ?? true) || !resource.read) {
    return { recorded: true };
  }
  const readStep = step.scope("read");
  const driftRead = yield* readDriftOperation(readStep, {
    resource,
    resourceParams: session.node.params,
    persistedOutput: session.node.output,
    // No dryRun: a dry run suppresses mutations, not reads.
    emit: durableEmitter(readStep, opts.emit),
    maxOperationAttempts: opts.maxOperationAttempts,
  });
  return { recorded: true, driftRead };
}

/**
 * The members of `cycle` whose contributions a replacement of `resource`
 * leaves out when it creates the resource again: the resource itself, as its
 * contributions hold the output of the resource that was deleted, and each
 * member in `deleted`, which the replacement deleted because it blocks the
 * delete, and which exists again only when deploy reaches it. Only the
 * members that `resource` refers to through its contributions alone count.
 * Empty when the resource can't be created without those contributions and
 * then updated with them.
 */
function replacedWithout(
  cycle: DeployUnit,
  resource: BaseResource,
  deleted: ReadonlySet<string>,
): ReadonlySet<BaseResource> {
  const dependencies = new Set(resource.getDependencies());
  const fixed = new Set(resource.getFixedDependencies());
  const without = new Set(
    cycle.members.filter(
      (member) =>
        (member === resource || deleted.has(member.id)) &&
        dependencies.has(member) &&
        !fixed.has(member),
    ),
  );
  return placeholderParamsBlocker(resource, without) ? new Set() : without;
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
