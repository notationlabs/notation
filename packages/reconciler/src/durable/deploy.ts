import {
  assertDependenciesPresent,
  buildResourceDepthLevels,
} from "../dependency-graph";
import { decideAction } from "../plan";
import {
  assertOutputsRecoverable,
  createReplaceCascade,
  planKnownParams,
} from "../planner";
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
 * Checks every value deploy knows before it changes anything, as the planner
 * does. A value that comes from an output that does not exist yet is checked
 * later, just before the operation of the resource that holds it. Decides
 * each resource's action, without drift detection, so that the check of
 * missing outputs passes a resource that deploy replaces.
 */
async function validateKnownParams(opts: DurableDeployOptions): Promise<void> {
  const cascade = createReplaceCascade({
    resources: opts.resources,
    stateNodes: await opts.state.values(),
    registry: opts.registry,
  });
  for (const level of buildResourceDepthLevels(opts.resources)) {
    for (const resource of level) {
      const { stateNode, params } = await planKnownParams(
        resource,
        opts.state,
        "deploy",
      );
      const action = decideAction({ resource, stateNode, params });
      const replaced = "replaceFields" in action;
      const replacedDependency = cascade.replacedDependency(resource.id);
      assertOutputsRecoverable(
        resource,
        stateNode,
        replaced || Boolean(replacedDependency),
      );
      cascade.add(resource, replaced);
    }
  }
}
