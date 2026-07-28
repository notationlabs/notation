import { buildResourceDepthLevels } from "../dependency-graph";
import { withDeploymentHold } from "./deployment-hold";
import { reconcileResource, sweepOrphans } from "./reconcile";
import type { DurableDeployOptions } from "./types";
import type { DurableStep } from "./yieldstar";

export async function* deploy(
  step: DurableStep,
  opts: DurableDeployOptions,
): AsyncGenerator<any, void, any> {
  yield* withDeploymentHold(step, opts, async function* () {
    // Reconcile in dependency order, so a resource only runs once its
    // dependencies have converged.
    for (const level of buildResourceDepthLevels(opts.resources)) {
      for (const resource of level) {
        yield* reconcileResource(step, resource, opts);
      }
    }

    // Then delete resources that are in state but no longer declared.
    yield* sweepOrphans(step, opts, "deploy");
  });
}
