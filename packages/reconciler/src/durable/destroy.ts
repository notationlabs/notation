import { buildResourceDepthLevels } from "../dependency-graph";
import { withDeploymentHold } from "./deployment-hold";
import { deleteResource, sweepOrphans } from "./reconcile";
import { scopeStep } from "./step";
import type { DurableWorkflowOptions } from "./types";
import type { DurableStep } from "./yieldstar";

/** Durably destroys persisted resources in reverse dependency order. */
export async function* destroy(
  step: DurableStep,
  opts: DurableWorkflowOptions,
): AsyncGenerator<any, void, any> {
  yield* withDeploymentHold(step, opts, async function* () {
    // Delete in reverse dependency order, so dependents are gone before the
    // resources they depend on.
    const levels = buildResourceDepthLevels(opts.resources);
    for (let index = levels.length - 1; index >= 0; index -= 1) {
      for (const resource of levels[index]!) {
        yield* deleteResource(
          scopeStep(
            step,
            `notation:destroy:${encodeURIComponent(resource.id)}`,
          ),
          resource,
          opts,
        );
      }
    }

    yield* sweepOrphans(step, opts, "destroy");
  });
}
