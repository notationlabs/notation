import { buildResourceDepthLevels } from "../dependency-graph";
import {
  acquireDeploymentCoordination,
  releaseDeploymentCoordination,
} from "./coordination";
import { reconcileResource, sweepOrphans } from "./operations";
import type { DurableDeployOptions } from "./types";
import type { DurableStep } from "./yieldstar";

export async function* deploy(
  step: DurableStep,
  opts: DurableDeployOptions,
): AsyncGenerator<any, void, any> {
  // Phase 1: take exclusive hold of the deployment.
  const coordination = yield* acquireDeploymentCoordination(step, opts);

  try {
    // Phase 2: reconcile in dependency order, so a resource only runs once
    // its dependencies have converged.
    for (const level of buildResourceDepthLevels(opts.resources)) {
      for (const resource of level) {
        yield* reconcileResource(step, resource, opts);
      }
    }

    // Phase 3: delete resources that are in state but no longer declared.
    yield* sweepOrphans(step, opts, {
      workflow: "deploy",
      listKey: "notation:orphans:list",
      warningKey: (nodeId) => `notation:orphan:${nodeId}:warning`,
      deleteSuffix: "orphan",
    });
  } finally {
    // Phase 4: release the hold, even on error.
    yield* releaseDeploymentCoordination(coordination, opts.executionId);
  }
}
