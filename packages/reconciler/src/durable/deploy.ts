import { validateParams } from "@notation/resource";
import {
  assertDependenciesPresent,
  buildResourceDepthLevels,
} from "../dependency-graph";
import { withDeploymentHold } from "./deployment-hold";
import { reconcileResource, sweepOrphans } from "./reconcile";
import { scopeStep } from "./step";
import type { DurableDeployOptions } from "./types";
import type { DurableStep } from "./yieldstar";

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
    for (const level of buildResourceDepthLevels(opts.resources)) {
      for (const resource of level) {
        yield* reconcileResource(
          scopeStep(step, `notation:deploy:${encodeURIComponent(resource.id)}`),
          resource,
          opts,
        );
      }
    }

    yield* sweepOrphans(step, opts, "deploy");
  });
}

/**
 * Checks every value deploy knows before it changes anything. As in the
 * planner, outputs from state stand in for the outputs of dependencies. A
 * value that comes from an output that does not exist yet is checked later,
 * just before the operation of the resource that holds it.
 */
async function validateKnownParams(opts: DurableDeployOptions): Promise<void> {
  for (const resource of opts.resources) {
    const stateNode = await opts.state.get(resource.id);
    if (stateNode) resource.setOutput(stateNode.output);
  }
  for (const resource of opts.resources) {
    await validateParams(resource, await resource.planParams(), "deploy");
  }
}
