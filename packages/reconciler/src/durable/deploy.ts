import { orderDeployUnits } from "../cycles";
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
      if (unit.kind === "cycle") {
        yield* reconcileCycle(step, unit.cycle, opts);
        continue;
      }
      yield* reconcileResource(
        scopeStep(
          step,
          `notation:deploy:${encodeURIComponent(unit.resource.id)}`,
        ),
        unit.resource,
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
 */
async function validateKnownParams(opts: DurableDeployOptions): Promise<void> {
  for (const unit of orderDeployUnits(opts.resources)) {
    for (const resource of await loadUnit(unit, opts.state)) {
      await planKnownParams(resource, opts.state, "deploy");
    }
  }
}
