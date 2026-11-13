import type { ResourceType } from "@notation/resource";
import { orderDeployUnits } from "../cycles";
import { keep, sweepSteps, sweptRecords } from "../orphan-sweep";
import { getDependencyIds } from "../plan";
import { resolveResourceClass, workflowRegistry } from "../resource-registry";
import { withDeploymentHold } from "./deployment-hold";
import {
  deleteResource,
  instantiateRecord,
  warnUnregistered,
} from "./reconcile";
import { scopeStep } from "./step";
import type { DurableWorkflowOptions } from "./types";
import type { DurableStep } from "./sdk";

/**
 * Durably destroys persisted resources, each after the resources that depend
 * on it.
 *
 * Each record is deleted with its retired instances, which are deleted just
 * before it. A record's edges are the edges in code, the edges in its record,
 * and the edges of its retired instances. So a dependent that a stopped
 * deploy did not reach, and that still uses a retired instance, is deleted
 * before that instance.
 *
 * The base order is the orphans in the order of deploy's sweep, then the
 * resources in code in the reverse of their deploy order. Before destroy
 * deletes a record, it deletes each record that has an edge to it, in the
 * same way. An edge between members of one cycle is skipped, so a cycle is
 * deleted in the reverse of its order in deploy. A placeholder still refers
 * to the members deleted before it, so its provider must delete a resource
 * that a dependent in state refers to. See `ResourceDeletion`. Where edges
 * form a loop across deploy units, the record reached first in the base
 * order is deleted last.
 *
 * A record whose type has no class is kept, with a warning, and so is every
 * record that it depends on.
 */
export async function* destroy(
  step: DurableStep,
  opts: DurableWorkflowOptions,
): AsyncGenerator<any, void, any> {
  yield* withDeploymentHold(step, opts, async function* () {
    const scope = scopeStep(step, "notation:orphans");
    const persisted = yield* scope.run("list", () => opts.state.values());
    const registry = workflowRegistry(opts);
    const resourceById = new Map(
      opts.resources.map((resource) => [resource.id, resource]),
    );
    const recordById = new Map(persisted.map((node) => [node.id, node]));

    const { swept, edgesById } = sweptRecords(
      persisted,
      new Set(resourceById.keys()),
    );
    for (const resource of opts.resources) {
      edgesById.set(resource.id, [
        ...getDependencyIds(resource),
        ...(recordById.get(resource.id)?.dependsOn ?? []),
        ...(edgesById.get(resource.id) ?? []),
      ]);
    }

    const kept = new Set<string>();
    for (const node of persisted) {
      const resource = resourceById.get(node.id);
      if (!resource || resource.type === node.type) continue;
      if (resolveResourceClass(registry, node.type as ResourceType)) continue;
      const keptDependencies = keep(node, edgesById, kept);
      yield* warnUnregistered(scope, opts, node, keptDependencies, "destroy");
    }
    const orphanSteps = sweepSteps(
      swept.filter((record) => record.orphan),
      registry,
      edgesById,
      kept,
    );
    for (const sweep of orphanSteps) {
      if (sweep.Resource) continue;
      yield* warnUnregistered(
        scope,
        opts,
        sweep.node,
        sweep.keptDependencies,
        "destroy",
      );
    }

    const units = orderDeployUnits(opts.resources).reverse();
    const unitOf = new Map<string, unknown>();
    for (const unit of units) {
      for (const member of unit.members) unitOf.set(member.id, unit);
    }
    const order = [
      ...orphanSteps.flatMap((sweep) =>
        sweep.Resource ? [sweep.node.id] : [],
      ),
      ...units.flatMap((unit) =>
        [...unit.members].reverse().map((member) => member.id),
      ),
    ];
    // An orphan is a unit of its own.
    const unitOfId = (id: string) => unitOf.get(id) ?? id;
    const dependentsById = new Map<string, string[]>();
    for (const dependent of order) {
      for (const id of new Set(edgesById.get(dependent))) {
        if (unitOfId(dependent) === unitOfId(id)) continue;
        dependentsById.set(id, [...(dependentsById.get(id) ?? []), dependent]);
      }
    }

    const done = new Set<string>();
    async function* visit(id: string): AsyncGenerator<any, void, any> {
      if (done.has(id) || kept.has(id)) return;
      done.add(id);
      for (const dependent of dependentsById.get(id) ?? []) {
        yield* visit(dependent);
      }
      const resource = resourceById.get(id);
      if (resource) {
        yield* deleteResource(
          scopeStep(step, `notation:destroy:${encodeURIComponent(id)}`),
          resource,
          opts,
          "destroy",
        );
        return;
      }
      const node = recordById.get(id)!;
      yield* deleteResource(
        scope.scope(encodeURIComponent(id)),
        await instantiateRecord(
          resolveResourceClass(registry, node.type as ResourceType)!,
          node,
        ),
        opts,
        "destroy",
      );
    }
    for (const id of order) yield* visit(id);
  });
}
