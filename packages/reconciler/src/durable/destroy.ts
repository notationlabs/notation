import { buildResourceDepthLevels } from "../dependency-graph";
import { withDeploymentHold } from "./coordination";
import { deleteResource, sweepOrphans } from "./operations";
import { scopeStep } from "./step";
import type { DurableDestroyOptions } from "./types";
import type { DurableStep } from "./yieldstar";

/** Durably destroys persisted resources in reverse dependency order. */
export async function* destroy(
  step: DurableStep,
  opts: DurableDestroyOptions,
): AsyncGenerator<any, void, any> {
  yield* withDeploymentHold(step, opts, async function* () {
    // Delete in reverse dependency order, so dependents are gone before the
    // resources they depend on. Resources with no persisted state were never
    // created (or are already deleted) and are skipped by deleteResource.
    const levels = buildResourceDepthLevels(opts.resources);
    for (let index = levels.length - 1; index >= 0; index -= 1) {
      for (const resource of levels[index]!) {
        yield* deleteResource(
          scopeStep(step, `notation:destroy:${resource.id}`),
          resource,
          opts,
        );
      }
    }

    // Then delete resources that are in state but no longer declared.
    yield* sweepOrphans(
      scopeStep(step, "notation:destroy:orphans"),
      opts,
      "destroy",
    );
  });
}
