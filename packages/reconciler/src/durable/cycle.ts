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
import type { OperationLifecycleEvent } from "../events";
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
 * change in the last of them, deploy fails and names those outputs.
 */
export async function* reconcileCycle(
  step: DurableStep,
  cycle: ResourceCycle,
  opts: DurableDeployOptions,
): AsyncGenerator<any, void, any> {
  const scope = (resource: BaseResource, suffix?: string) =>
    scopeStep(
      step,
      `notation:deploy:${encodeURIComponent(resource.id)}${suffix ? `:${suffix}` : ""}`,
    );
  // A second create in one execution would reuse the create effect IDs of
  // the first, so it would not run.
  const created = new Set<BaseResource>();
  const options = (resource: BaseResource): ReconcileOptions => ({
    onDecision: (decision) => {
      if (!CREATING_DECISIONS.includes(decision)) return;
      if (created.has(resource)) {
        throw new ResourceCycleError(
          `${resource.id} would be ${decision === "replace" || decision === "drift-replace" ? "replaced" : "created"} while its cycle with ${listIds(others(cycle, resource))} settles, after this deploy created it. A param of ${resource.id} that forces a replacement takes a value from an output of another member of the cycle, and that output changed when the member was updated with its contributions. Take the param from an output that stays the same, such as a name.`,
        );
      }
      created.add(resource);
    },
    beforeReplace: () =>
      revertPeers(scope(resource, "revert"), cycle, resource, opts),
  });

  for (const resource of cycle.members) {
    const placeholder = cycle.placeholders.includes(resource);
    yield* reconcileResource(
      scope(resource, placeholder ? "placeholder" : undefined),
      resource,
      opts,
      placeholder
        ? { ...options(resource), placeholder: true }
        : options(resource),
    );
  }

  let changed: string[] = [];
  for (let pass = 1; pass <= cycle.members.length; pass += 1) {
    changed = [];
    for (const resource of cycle.members) {
      // This loop's first pass is the first time that deploy reconciles a
      // placeholder with its full params, so the placeholder is checked for
      // drift then, and its noop is announced.
      const first = pass === 1 && cycle.placeholders.includes(resource);
      const before = resource.output as Record<string, unknown> | null;
      yield* reconcileResource(
        scope(resource, `settle:${pass}`),
        resource,
        first ? opts : { ...opts, driftDetection: false },
        {
          ...options(resource),
          writeKey: `settle:${pass}`,
          quietNoop: !first,
        },
      );
      changed.push(...changedOutputs(resource, before));
    }
    if (changed.length === 0 || opts.dryRun) return;
  }

  throw new ResourceCycleError(
    `The cycle of ${listIds(cycle.members)} did not settle after ${cycle.members.length + 1} passes. These outputs changed in the last pass: ${changed.join(", ")}. When a member takes an output of another member, take a value that stays the same across updates, such as a name, in place of one that changes on every update, such as a version ID.`,
  );
}

/**
 * Reverts the peers of `replaced` that refer to it, so that the provider
 * does not refuse to delete it. See `revertedPeers`.
 */
async function* revertPeers(
  step: DurableStepRunner,
  cycle: ResourceCycle,
  replaced: BaseResource,
  opts: DurableDeployOptions,
): AsyncGenerator<any, void, any> {
  for (const peer of revertedPeers(cycle, replaced)) {
    yield* revertToPlaceholder(
      step.scope(encodeURIComponent(peer.id)),
      peer,
      opts,
      `revert:${encodeURIComponent(replaced.id)}`,
      { reason: "cycle-revert", replacedDependency: replaced.id },
    );
  }
}

/**
 * Updates a resource with its placeholder params, so that it no longer
 * refers to the other members of its cycle. Does nothing when the resource
 * has no record, when the record has another type, or when a fixed
 * dependency has no output.
 */
export async function* revertToPlaceholder(
  step: DurableStepRunner,
  resource: BaseResource,
  opts: DurableWorkflowOptions,
  /** See `ReconcileOptions.writeKey`. */
  writeKey: string,
  /** Added to the update's lifecycle events. */
  cause: Pick<OperationLifecycleEvent, "reason" | "replacedDependency">,
): AsyncGenerator<any, void, any> {
  const session = yield* openStateSession(step, opts, resource, writeKey);
  if (!session.node || session.node.type !== resource.type) return;
  resource.setOutput(session.node.output);

  const missing = resource
    .getFixedDependencies()
    .filter((dependency) => dependency.output == null);
  const records = yield* step.run("dependency-outputs", () =>
    Promise.all(missing.map((dependency) => opts.state.get(dependency.id))),
  );
  for (const [index, dependency] of missing.entries()) {
    const record = records[index];
    if (!record) return;
    dependency.setOutput(record.output);
  }

  const params = yield* step.run("params", () =>
    resource.getParams({ contributions: false }),
  );
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
    emit: (event) => emit({ ...event, ...cause }),
    maxOperationAttempts: opts.maxOperationAttempts,
    persist: session.persist,
  });
}

function others(cycle: ResourceCycle, except: BaseResource): BaseResource[] {
  return cycle.members.filter((member) => member !== except);
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
