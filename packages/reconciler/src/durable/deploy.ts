import type { StateNode } from "@notation/state";
import { isCycle, orderDeployUnits } from "../cycles";
import { assertDependenciesPresent } from "../dependency-graph";
import { sweepSteps, sweptRecords } from "../orphan-sweep";
import { assertOrphanDeleteAllowed, decideAction } from "../plan";
import { loadUnit, planKnownParams } from "../planner";
import { readRecordedOutputs } from "../recorded-outputs";
import { workflowRegistry, type ResourceRegistry } from "../resource-registry";
import { reconcileCycle } from "./cycle";
import { withDeploymentHold } from "./deployment-hold";
import { reconcileResource, sweepOrphans } from "./reconcile";
import { scopeStep } from "./step";
import type { DeployContext, DurableDeployOptions } from "./types";
import type { DurableStep } from "./sdk";

export async function* deploy(
  step: DurableStep,
  opts: DurableDeployOptions,
): AsyncGenerator<any, void, any> {
  assertDependenciesPresent(opts.resources);
  // A step, so that a resumed execution does not run every resource's
  // deriveParams again.
  yield* step.run("notation:validate", async () => {
    await validateKnownParams(opts);
    return null;
  });
  yield* withDeploymentHold(step, opts, async function* () {
    // Read once, inside the hold, so that every `~state` ref reads the
    // records as they were at the start of the deploy, and a resumed deploy
    // reads the same ones.
    const deployOpts: DeployContext = {
      ...opts,
      recordedOutputs: yield* step.run("notation:recorded-outputs", () =>
        readRecordedOutputs(opts.resources, opts.state),
      ),
    };
    // Reconcile in dependency order, so a resource only runs once its
    // dependencies have converged.
    for (const unit of orderDeployUnits(opts.resources)) {
      if (isCycle(unit)) {
        yield* reconcileCycle(step, unit, deployOpts);
        continue;
      }
      const [resource] = unit.members;
      yield* reconcileResource(
        scopeStep(step, `notation:deploy:${encodeURIComponent(resource!.id)}`),
        resource!,
        deployOpts,
      );
    }

    yield* sweepOrphans(step, deployOpts);
  });
}

/**
 * Checks every value deploy knows before it changes anything, as the planner
 * does, and runs each `rejectChange`, also for each orphan that the sweep
 * deletes. A value that comes from an output that does not exist yet is
 * checked later, just before the operation of the resource that holds it.
 *
 * A required output missing from the record of a resource with no `read` is
 * not checked here, on purpose. It is checked in `reconcileResource`, so a
 * deploy can fail there after it has deployed the resources before it. A
 * check here would need deploy's decision for the resource, which depends on
 * drift reads and on the outputs of dependencies that deploy creates again.
 * Neither is known yet, so the check would fail deploys that succeed. Plan
 * still checks before any change.
 */
async function validateKnownParams(opts: DurableDeployOptions): Promise<void> {
  const recordedOutputs = await readRecordedOutputs(opts.resources, opts.state);
  for (const unit of orderDeployUnits(opts.resources)) {
    for (const resource of await loadUnit(unit, opts.state)) {
      const { stateNode, params } = await planKnownParams(
        resource,
        opts.state,
        "deploy",
        recordedOutputs,
      );
      if (stateNode) decideAction({ resource, stateNode, params });
    }
  }
  const registry = workflowRegistry(opts);
  for (const stateNode of orphansDeployDeletes(
    await opts.state.values(),
    new Set(opts.resources.map((resource) => resource.id)),
    registry,
  )) {
    assertOrphanDeleteAllowed(registry, stateNode);
  }
}

/** The orphans that deploy's sweep deletes, in delete order. */
function orphansDeployDeletes(
  records: StateNode[],
  inCode: ReadonlySet<string>,
  registry: ResourceRegistry,
): StateNode[] {
  const { swept, edgesById } = sweptRecords(records, inCode);
  return sweepSteps(swept, registry, edgesById, new Set())
    .filter((step) => step.Resource && step.orphan)
    .map((step) => step.node);
}
