import { isCycle, orderDeployUnits } from "../cycles";
import { assertDependenciesPresent } from "../dependency-graph";
import { loadUnit, planKnownParams } from "../planner";
import { reconcileCycle } from "./cycle";
import { withDeploymentHold } from "./deployment-hold";
import { reconcileResource, sweepOrphans } from "./reconcile";
import { scopeStep } from "./step";
import type { DurableDeployOptions } from "./types";
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
    // Reconcile in dependency order, so a resource only runs once its
    // dependencies have converged.
    for (const unit of orderDeployUnits(opts.resources)) {
      if (isCycle(unit)) {
        yield* reconcileCycle(step, unit, opts);
        continue;
      }
      const [resource] = unit.members;
      yield* reconcileResource(
        scopeStep(step, `notation:deploy:${encodeURIComponent(resource!.id)}`),
        resource!,
        opts,
      );
    }

    yield* sweepOrphans(step, opts, "deploy");
  });
}

/**
 * Checks every value deploy knows before it changes anything, as the planner
 * does. A value that comes from an output that does not exist yet is checked
 * later, just before the operation of the resource that holds it.
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
  for (const unit of orderDeployUnits(opts.resources)) {
    for (const resource of await loadUnit(unit, opts.state)) {
      await planKnownParams(resource, opts.state, "deploy");
    }
  }
}
