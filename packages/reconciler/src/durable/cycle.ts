import {
  changedKeys,
  diffParams,
  validateParams,
  type BaseResource,
} from "@notation/resource";
import {
  ResourceCycleError,
  listIds,
  revertedPeers,
  type ResourceCycle,
} from "../cycles";
import { updateResourceOperation } from "../operations";
import { getDependencyIds, type ResourceAction } from "../plan";
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
 *    record is left as it is. Every other member is reconciled as usual.
 * 2. Each later pass reconciles every member with its full params. A pass in
 *    which no member's output changes ends the deploy of the cycle.
 *
 * A cycle of N members gets N passes after the first. When outputs still
 * change in the last of them, deploy fails and names those outputs. A dry
 * run stops after the first pass, as it creates and updates nothing.
 */
export async function* reconcileCycle(
  step: DurableStep,
  cycle: ResourceCycle,
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
      // Reverts the peers that refer to `resource`, so that the provider
      // does not refuse to delete it.
      for (const peer of revertedPeers(cycle, resource)) {
        yield* revertToPlaceholder(
          revertStep.scope(encodeURIComponent(peer.id)),
          peer,
          opts,
          cycle,
          resource,
        );
      }
    },
  });

  for (const resource of cycle.members) {
    const placeholder = cycle.placeholders.includes(resource);
    yield* reconcileResource(
      scope(resource, placeholder ? "placeholder" : undefined),
      resource,
      opts,
      placeholder
        ? { ...options(resource), placeholder: members }
        : options(resource),
    );
  }
  if (opts.dryRun) return;

  let changed: string[] = [];
  for (let pass = 1; pass <= cycle.members.length; pass += 1) {
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
    `The cycle of ${listIds(cycle.members)} did not settle after ${cycle.members.length + 1} passes. These outputs changed in the last pass: ${changed.join(", ")}. When a member takes an output of another member, take a value that stays the same across updates, such as a name, in place of one that changes on every update, such as a version ID.`,
  );
}

/**
 * Updates a member of `cycle` with its placeholder params, so that it no
 * longer refers to the other members. Deploy does this before it replaces
 * `replaced`, and destroy does it for each placeholder, with no `replaced`.
 * The params start from the record, so that a change to the config since
 * the last deploy is not part of the update. Only the params that the
 * contributions that depend on the other members set take their placeholder
 * values. Does nothing when the resource has no record, or when the record
 * has another type.
 */
export async function* revertToPlaceholder(
  parent: DurableStepRunner,
  resource: BaseResource,
  opts: DurableWorkflowOptions,
  cycle: ResourceCycle,
  replaced?: BaseResource,
): AsyncGenerator<any, void, any> {
  const revertKey = replaced
    ? `revert:${encodeURIComponent(replaced.id)}`
    : "revert";
  const step = parent.scope("revert", revertKey);
  const peers = new Set(cycle.members);
  const session = yield* openStateSession(step, opts, resource);
  if (!session.node || session.node.type !== resource.type) return;
  resource.setOutput(session.node.output);

  // Peers that are only in contributions are left out of the placeholder
  // params, so their outputs are not needed.
  const fixed = new Set(resource.getFixedDependencies());
  const missing = resource
    .getDependencies()
    .filter(
      (dependency) =>
        (fixed.has(dependency) || !peers.has(dependency)) &&
        dependency.output == null,
    );
  const records = yield* step.run("dependency-outputs", () =>
    Promise.all(missing.map((dependency) => opts.state.get(dependency.id))),
  );
  for (const [index, dependency] of missing.entries()) {
    const record = records[index];
    if (!record || record.type !== dependency.type) {
      throw new ResourceCycleError(
        `Cannot revert ${resource.id} to its placeholder params: its dependency ${dependency.id} ${record ? `has a state record of type ${record.type}, not ${dependency.type}` : "has no state record"}, so its output is not known.`,
      );
    }
    dependency.setOutput(record.output);
  }

  const placeholder = yield* step.run("params", () =>
    resource.getParams({ excludeContributionsFrom: peers }),
  );
  const params: Record<string, unknown> = { ...session.node.params };
  for (const [key, item] of Object.entries(resource.schema)) {
    // State does not hold hidden params.
    if (item.hidden) params[key] = placeholder[key];
  }
  // These params neither are required nor force a replacement: the cycle's
  // placeholders and the peers that `revertedPeers` returns are checked for
  // that when deploy and destroy order the resources.
  for (const key of resource.getContributedParams({ from: peers })) {
    params[key] = placeholder[key];
  }
  await validateParams(resource, params, "deploy");
  const { patch } = diffParams(resource.schema, session.node.params, params, {
    canUpdate: true,
  });
  if (Object.keys(patch).length === 0) return;

  const emit = durableEmitter(step, opts.emit);
  yield* updateResourceOperation(step, {
    resource,
    resourceParams: params,
    persistedOutput: session.node.output,
    patch,
    dependsOn: getDependencyIds(resource),
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
}

/**
 * The error for a member that deploy would create or replace a second time
 * while its cycle settles.
 */
function recreateError(
  cycle: ResourceCycle,
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
