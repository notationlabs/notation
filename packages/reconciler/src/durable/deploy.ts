import { buildResourceDepthLevels } from "../dependency-graph";
import { withDeploymentHold } from "./deployment-hold";
import { reconcileResource, sweepOrphans } from "./reconcile";
import { scopeStep } from "./step";
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
        yield* reconcileResource(
          scopeStep(
            step,
            `notation:deploy:${encodeURIComponent(resource.id)}`,
          ),
          resource,
          opts,
        );
      }
    }

    yield* sweepOrphans(step, opts, "deploy");
  });
}
