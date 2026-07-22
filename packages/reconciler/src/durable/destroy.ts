import { buildResourceDepthLevels } from "../dependency-graph";
import {
  acquireDeploymentCoordination,
  releaseDeploymentCoordination,
} from "./coordination";
import { deleteResource, sweepOrphans } from "./operations";
import type { DurableDestroyOptions } from "./types";
import type { DurableStep } from "./yieldstar";

/** Durably destroys persisted resources in reverse dependency order. */
export async function* destroy(
  step: DurableStep,
  opts: DurableDestroyOptions,
): AsyncGenerator<any, void, any> {
  // Phase 1: take exclusive hold of the deployment.
  const coordination = yield* acquireDeploymentCoordination(step, opts);

  try {
    // Phase 2: delete in reverse dependency order, so dependents are gone
    // before the resources they depend on. Resources with no persisted state
    // were never created (or are already deleted) and are skipped.
    const levels = buildResourceDepthLevels(opts.resources);
    for (let index = levels.length - 1; index >= 0; index -= 1) {
      for (const resource of levels[index]!) {
        const stateNode = yield* step.run(
          `notation:destroy:${resource.id}:state:lookup`,
          () => opts.state.get(resource.id),
        );
        if (!stateNode) continue;
        resource.setOutput(stateNode.output);
        yield* deleteResource(step, resource, opts, "destroy");
      }
    }

    // Phase 3: delete resources that are in state but no longer declared.
    yield* sweepOrphans(step, opts, {
      workflow: "destroy",
      listKey: "notation:destroy:orphans:list",
      warningKey: (nodeId) => `notation:destroy:orphan:${nodeId}:warning`,
      deleteSuffix: "destroy-orphan",
    });
  } finally {
    // Phase 4: release the hold, even on error.
    yield* releaseDeploymentCoordination(coordination, opts.executionId);
  }
}
