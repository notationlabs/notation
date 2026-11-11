import {
  diffParams,
  validateParams,
  type BaseResource,
} from "@notation/resource";
import {
  ResourceCycleError,
  placeholderParamsBlocker,
  type ResourceCycle,
} from "../cycles";
import type { OperationLifecycleEvent } from "../events";
import {
  createResourceOperation,
  updateResourceOperation,
} from "../operations";
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
          `${resource.id} would be ${decision === "replace" || decision === "drift-replace" ? "replaced" : "created"} while its cycle with ${otherIds(cycle, resource)} settles, after this deploy created it. A param of ${resource.id} that forces a replacement takes a value from an output of another member of the cycle, and that output changed when the member was updated with its contributions. Take the param from an output that stays the same, such as a name.`,
        );
      }
      created.add(resource);
    },
    beforeReplace: () =>
      revertPeers(scope(resource, "revert"), cycle, resource, opts),
  });

  for (const resource of cycle.members) {
    if (cycle.placeholders.includes(resource)) {
      const placed = yield* createPlaceholder(
        scope(resource, "placeholder"),
        resource,
        opts,
      );
      if (placed) created.add(resource);
      continue;
    }
    yield* reconcileResource(
      scope(resource),
      resource,
      opts,
      options(resource),
    );
  }

  let changed: string[] = [];
  for (let pass = 1; pass <= cycle.members.length; pass += 1) {
    changed = [];
    for (const resource of cycle.members) {
      // The first pass is the first time deploy reaches a placeholder with
      // its full params, so it is checked for drift and its noop announced.
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
    `The cycle of ${otherIds(cycle)} did not settle after ${cycle.members.length + 1} passes. Each update changed an output that another member of the cycle takes: ${changed.join(", ")}. Take a value that stays the same across updates, such as a name, in place of one that changes on every update, such as a version ID.`,
  );
}

/**
 * Creates a placeholder with no record. Returns whether it created one. A
 * placeholder with a record keeps it, and its output is loaded for the
 * members that follow it.
 */
async function* createPlaceholder(
  step: DurableStepRunner,
  resource: BaseResource,
  opts: DurableDeployOptions,
): AsyncGenerator<any, boolean, any> {
  const session = yield* openStateSession(step, opts, resource);
  assertSameType(resource, session.node);
  if (session.node) {
    resource.setOutput(session.node.output);
    return false;
  }

  const params = yield* step.run("params", () =>
    resource.getPlaceholderParams(),
  );
  await validateParams(resource, params, "deploy");
  const emit = durableEmitter(step, opts.emit);
  yield* emit({
    level: "info",
    event: "reconciler.deploy.decision",
    resourceId: resource.id,
    resourceType: resource.type,
    decision: "create",
    placeholder: true,
  });
  yield* createResourceOperation(step, {
    executionId: opts.executionId,
    resource,
    resourceParams: params,
    dependsOn: getDependencyIds(resource),
    dryRun: opts.dryRun,
    emit,
    maxOperationAttempts: opts.maxOperationAttempts,
    persist: session.persist,
  });
  return true;
}

/**
 * Reverts each member of the cycle that refers to `replaced` through its
 * contributions, so that the provider does not refuse to delete `replaced`.
 * A member whose params can't go back to its placeholder params with an
 * update keeps them.
 */
async function* revertPeers(
  step: DurableStepRunner,
  cycle: ResourceCycle,
  replaced: BaseResource,
  opts: DurableDeployOptions,
): AsyncGenerator<any, void, any> {
  for (const peer of cycle.members) {
    if (peer === replaced) continue;
    if (!peer.getDependencies().includes(replaced)) continue;
    if (peer.getFixedDependencies().includes(replaced)) continue;
    if (placeholderParamsBlocker(peer)) continue;
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
    .filter((dependency) => dependency.output == null)
    .map((dependency) => dependency.id);
  const records = yield* step.run("dependency-outputs", () =>
    Promise.all(missing.map((id) => opts.state.get(id))),
  );
  for (const [index, id] of missing.entries()) {
    const record = records[index];
    if (!record) return;
    resource
      .getFixedDependencies()
      .find((dependency) => dependency.id === id)!
      .setOutput(record.output);
  }

  const params = yield* step.run("params", () =>
    resource.getPlaceholderParams(),
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

function otherIds(cycle: ResourceCycle, except?: BaseResource): string {
  const ids = cycle.members
    .filter((member) => member !== except)
    .map((member) => member.id);
  if (ids.length <= 1) return ids.join("");
  return `${ids.slice(0, -1).join(", ")} and ${ids.at(-1)}`;
}

/**
 * The outputs of `resource` that differ from `before`, as `<id>.<key>`. Both
 * sides are compared as state records them, as an output loaded from state
 * has no hidden fields.
 */
function changedOutputs(
  resource: BaseResource,
  previous: Record<string, unknown> | null,
): string[] {
  const before: Record<string, unknown> = previous
    ? resource.toState(previous)
    : {};
  const after: Record<string, unknown> = resource.output
    ? resource.toState(resource.output)
    : {};
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys]
    .filter((key) => canonical(before[key]) !== canonical(after[key]))
    .sort()
    .map((key) => `${resource.id}.${key}`);
}

function canonical(value: unknown): string {
  return (
    JSON.stringify(value, (_key, entry) =>
      entry && typeof entry === "object" && !Array.isArray(entry)
        ? Object.fromEntries(
            Object.entries(entry).sort(([a], [b]) => (a < b ? -1 : 1)),
          )
        : entry,
    ) ?? "undefined"
  );
}
