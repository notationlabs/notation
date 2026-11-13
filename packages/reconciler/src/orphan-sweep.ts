import type { ResourceClass, ResourceType } from "@notation/resource";
import type { StateNode } from "@notation/state";
import { buildDepthLevels } from "./dependency-graph";
import {
  resolveResourceClass,
  type ResourceRegistry,
} from "./resource-registry";

export type OrphanSweepStep =
  | { node: StateNode; Resource: ResourceClass<any, any, any> }
  | { node: StateNode; Resource?: undefined; keptDependencies: string[] };

/**
 * The steps of the orphan sweep, in delete order: each orphan that it
 * deletes, with its class, and each orphan whose class isn't registered,
 * with the resources that it keeps in place. An orphan that `kept` holds, or
 * that an orphan with no class depends on, is left out. `kept` gains each
 * resource that the sweep keeps.
 */
export function orphanSweepSteps(
  orphans: StateNode[],
  registry: ResourceRegistry,
  edgesById: Map<string, string[]>,
  kept: Set<string>,
): OrphanSweepStep[] {
  const steps: OrphanSweepStep[] = [];
  for (const node of orderOrphanDeletes(orphans)) {
    const Resource = resolveResourceClass(registry, node.type as ResourceType);
    // An unregistered orphan is listed even when another orphan already
    // keeps it, so that the warnings name every type the sweep could not
    // delete.
    if (!Resource) {
      steps.push({ node, keptDependencies: keep(node, edgesById, kept) });
      continue;
    }
    if (!kept.has(node.id)) steps.push({ node, Resource });
  }
  return steps;
}

/**
 * The records that are no longer in code, and the edges between them, as
 * deploy's sweep follows them.
 */
export function orphanRecords(
  records: StateNode[],
  inCode: ReadonlySet<string>,
): { orphans: StateNode[]; edgesById: Map<string, string[]> } {
  const orphans = records.filter((node) => !inCode.has(node.id));
  return {
    orphans,
    edgesById: new Map(orphans.map((node) => [node.id, node.dependsOn ?? []])),
  };
}

/** The orphans that deploy's sweep deletes, in delete order. */
export function orphansDeployDeletes(
  records: StateNode[],
  inCode: ReadonlySet<string>,
  registry: ResourceRegistry,
): StateNode[] {
  const { orphans, edgesById } = orphanRecords(records, inCode);
  return orphanSweepSteps(orphans, registry, edgesById, new Set())
    .filter((step) => step.Resource)
    .map((step) => step.node);
}

/**
 * Keeps `node` and the resources that it depends on, directly or through
 * each other, among those that `edgesById` holds edges for. Returns the
 * resources that it depends on.
 */
export function keep(
  node: StateNode,
  edgesById: Map<string, string[]>,
  kept: Set<string>,
): string[] {
  const keptDependencies = collectDependencies(node, edgesById);
  kept.add(node.id);
  for (const id of keptDependencies) kept.add(id);
  return keptDependencies;
}

/**
 * Orders orphans so that each is deleted before the orphans it depends on.
 * An edge to a resource that is not an orphan is ignored.
 *
 * A record with no edges was written before edges were recorded, and keeps
 * its storage order among the records it has no edges to. Orphans that form
 * a cycle, and the orphans that depend on them, cannot be ordered, and are
 * deleted first, in storage order.
 */
function orderOrphanDeletes(orphans: StateNode[]): StateNode[] {
  const { levels, unordered } = buildDepthLevels(
    orphans,
    (node) => node.id,
    (node) => node.dependsOn ?? [],
  );
  return [...unordered, ...levels.reverse().flat()];
}

function collectDependencies(
  node: StateNode,
  edgesById: Map<string, string[]>,
): string[] {
  const found = new Set<string>();
  const pending = [...(node.dependsOn ?? [])];
  while (pending.length > 0) {
    const id = pending.pop()!;
    const edges = edgesById.get(id);
    if (found.has(id) || id === node.id || !edges) continue;
    found.add(id);
    pending.push(...edges);
  }
  return [...found].sort();
}
