import { validateParams, type BaseResource } from "@notation/resource";
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
  let checked = new Map<BaseResource, CheckedParams>();
  yield* step.run("notation:validate", async () => {
    checked = await validateKnownParams(opts);
    return null;
  });
  const getParams = (resource: BaseResource) =>
    reuseCheckedParams(resource, checked.get(resource)) ?? resource.getParams();
  yield* withDeploymentHold(step, opts, async function* () {
    // Reconcile in dependency order, so a resource only runs once its
    // dependencies have converged.
    for (const level of buildResourceDepthLevels(opts.resources)) {
      for (const resource of level) {
        yield* reconcileResource(
          scopeStep(step, `notation:deploy:${encodeURIComponent(resource.id)}`),
          resource,
          opts,
          getParams,
        );
      }
    }

    yield* sweepOrphans(step, opts, "deploy");
  });
}

type Params = Awaited<ReturnType<BaseResource["getParams"]>>;

type CheckedParams = {
  params: Params;
  dependencyOutputs: unknown[];
};

/**
 * Checks every value deploy knows before it changes anything. As in the
 * planner, outputs from state stand in for the outputs of dependencies. A
 * value that comes from an output that does not exist yet is checked later,
 * just before the operation of the resource that holds it.
 *
 * Returns the params of each resource whose dependencies all have outputs,
 * with those outputs, so deploy can reuse the params instead of running
 * `deriveParams` again.
 */
async function validateKnownParams(
  opts: DurableDeployOptions,
): Promise<Map<BaseResource, CheckedParams>> {
  for (const resource of opts.resources) {
    const stateNode = await opts.state.get(resource.id);
    if (stateNode) resource.setOutput(stateNode.output);
  }
  const checked = new Map<BaseResource, CheckedParams>();
  for (const resource of opts.resources) {
    const dependencies = resource.getDependencies();
    if (dependencies.some((dependency) => dependency.output == null)) {
      await validateParams(resource, await resource.planParams(), "deploy");
      continue;
    }
    const params = await resource.getParams();
    await validateParams(resource, params, "deploy");
    checked.set(resource, {
      params,
      dependencyOutputs: dependencies.map((dependency) => dependency.output),
    });
  }
  return checked;
}

/**
 * Params depend on config, contributions and the outputs of dependencies.
 * Config and contributions are fixed once deploy starts, so the checked
 * params still hold while the dependencies' outputs are unchanged.
 */
function reuseCheckedParams(
  resource: BaseResource,
  checked: CheckedParams | undefined,
): Promise<Params> | undefined {
  if (!checked) return undefined;
  const unchanged = resource
    .getDependencies()
    .every((dependency, index) =>
      isSameValue(dependency.output, checked.dependencyOutputs[index]),
    );
  return unchanged ? Promise.resolve(checked.params) : undefined;
}

// Compares JSON values. Any other object counts as different unless it is
// the same object, which only costs a call to deriveParams.
function isSameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return (
      a.length === b.length && a.every((entry, i) => isSameValue(entry, b[i]))
    );
  }
  if (!isPlainObject(a) || !isPlainObject(b)) return false;
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => Object.hasOwn(b, key) && isSameValue(a[key], b[key]))
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
