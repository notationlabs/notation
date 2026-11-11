import { orderDeployUnits } from "../cycles";
import { revertToPlaceholder } from "./cycle";
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
    const kept = yield* sweepOrphans(step, opts, "destroy");

    // Delete in reverse dependency order, so dependents are gone before the
    // resources they depend on. The placeholders of a cycle are reverted
    // first, so that the members that remain can be deleted in reverse order
    // too.
    for (const unit of orderDeployUnits(opts.resources).reverse()) {
      const scope = (id: string) =>
        scopeStep(step, `notation:destroy:${encodeURIComponent(id)}`);
      if (unit.kind === "cycle") {
        for (const placeholder of unit.cycle.placeholders) {
          if (kept.has(placeholder.id)) continue;
          yield* revertToPlaceholder(
            scope(placeholder.id).scope("revert"),
            placeholder,
            opts,
            "revert",
            { reason: "cycle-revert" },
          );
        }
      }
      const members =
        unit.kind === "cycle" ? unit.cycle.members : [unit.resource];
      for (const resource of [...members].reverse()) {
        if (kept.has(resource.id)) continue;
        yield* deleteResource(scope(resource.id), resource, opts);
      }
    }
  });
}
