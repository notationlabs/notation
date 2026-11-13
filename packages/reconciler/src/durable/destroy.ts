import { orderDeployUnits } from "../cycles";
import { withDeploymentHold } from "./deployment-hold";
import { deleteResource, sweepOrphans } from "./reconcile";
import { scopeStep } from "./step";
import type { DurableWorkflowOptions } from "./types";
import type { DurableStep } from "./sdk";

/** Durably destroys persisted resources in reverse dependency order. */
export async function* destroy(
  step: DurableStep,
  opts: DurableWorkflowOptions,
): AsyncGenerator<any, void, any> {
  yield* withDeploymentHold(step, opts, async function* () {
    // Orphans go first: an orphan can depend on a resource in the desired
    // set, but no resource in the desired set depends on an orphan. The sweep
    // returns the IDs it left in place, and destroy leaves them too.
    const { kept, deleteRetiredDependents } = yield* sweepOrphans(
      step,
      opts,
      "destroy",
    );

    // Delete in reverse dependency order, so dependents are gone before the
    // resources they depend on. The members of a cycle are deleted in the
    // reverse of their order in deploy. A placeholder still refers to the
    // members deleted before it, so its provider must delete a resource that
    // a dependent in state refers to. See `ResourceDeletion`. A record's
    // retired instances are deleted with the record, or earlier when a
    // resource that one of them depends on comes first.
    for (const unit of orderDeployUnits(opts.resources).reverse()) {
      for (const resource of [...unit.members].reverse()) {
        if (kept.has(resource.id)) continue;
        yield* deleteRetiredDependents(resource.id);
        yield* deleteResource(
          scopeStep(
            step,
            `notation:destroy:${encodeURIComponent(resource.id)}`,
          ),
          resource,
          opts,
          "destroy",
        );
      }
    }
  });
}
