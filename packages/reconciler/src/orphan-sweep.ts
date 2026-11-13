import type { ResourceClass, ResourceType } from "@notation/resource";
import { hasRetiredInstances, type StateNode } from "@notation/state";
import { buildDepthLevels } from "./dependency-graph";
import {
  resolveResourceClass,
  type ResourceRegistry,
} from "./resource-registry";

/**
 * A record that the sweep reaches. For an orphan, the sweep deletes its
 * retired instances and then the record. For a record in code, it deletes
 * only the retired instances.
 */
export type SweptRecord = { node: StateNode; orphan: boolean };

export type OrphanSweepStep = SweptRecord &
  (
    | { Resource: ResourceClass<any, any, any> }
    | { Resource?: undefined; keptDependencies: string[] }
  );

/**
 * The steps of the sweep, in delete order: each record that it deletes or
 * deletes retired instances of, with its class, and each orphan whose class
 * isn't registered, with the resources that it keeps in place. A record that
 * `kept` holds, or that an orphan with no class depends on, is left out.
 * `kept` gains each resource that the sweep keeps.
 */
export function orphanSweepSteps(
  swept: SweptRecord[],
  registry: ResourceRegistry,
  edgesById: Map<string, string[]>,
  kept: Set<string>,
): OrphanSweepStep[] {
  const steps: OrphanSweepStep[] = [];
  for (const record of orderSweep(swept, edgesById)) {
    const { node } = record;
    const Resource = resolveResourceClass(registry, node.type as ResourceType);
    // An unregistered orphan is listed even when another orphan already
    // keeps it, so that the warnings name every type the sweep could not
    // delete. A record in code with no class is destroy's to warn about.
    if (!Resource) {
      if (!record.orphan) continue;
      steps.push({
        ...record,
        keptDependencies: keep(node, edgesById, kept),
      });
      continue;
    }
    if (!kept.has(node.id)) steps.push({ ...record, Resource });
  }
  return steps;
}

/**
 * The records that the sweep reaches, and the edges between them: the
 * orphans, and the records in code that list retired instances. An orphan
 * has its own edges and those of its retired instances. A record in code has
 * the edges of its retired instances, as its own edges belong to the
 * resource that replaced them.
 */
export function sweptRecords(
  records: StateNode[],
  inCode: ReadonlySet<string>,
): { swept: SweptRecord[]; edgesById: Map<string, string[]> } {
  const swept = records
    .filter((node) => !inCode.has(node.id) || hasRetiredInstances(node))
    .map((node) => ({ node, orphan: !inCode.has(node.id) }));
  return {
    swept,
    edgesById: new Map(
      swept.map(({ node, orphan }) => [node.id, sweptEdges(node, orphan)]),
    ),
  };
}

function sweptEdges(node: StateNode, orphan: boolean): string[] {
  const edges = new Set(orphan ? (node.dependsOn ?? []) : []);
  for (const instance of node.retired ?? []) {
    for (const id of instance.dependsOn) edges.add(id);
  }
  return [...edges].sort();
}

/** The orphans that deploy's sweep deletes, in delete order. */
export function orphansDeployDeletes(
  records: StateNode[],
  inCode: ReadonlySet<string>,
  registry: ResourceRegistry,
): StateNode[] {
  const { swept, edgesById } = sweptRecords(records, inCode);
  return orphanSweepSteps(swept, registry, edgesById, new Set())
    .filter((step) => step.Resource && step.orphan)
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
 * Orders the swept records so that each is deleted before the records it
 * depends on. An edge to a record that the sweep doesn't reach is ignored.
 *
 * A record with no edges was written before edges were recorded, and keeps
 * its storage order among the records it has no edges to. Records that form
 * a cycle, and the records that depend on them, cannot be ordered, and are
 * deleted first, in storage order.
 */
function orderSweep(
  swept: SweptRecord[],
  edgesById: Map<string, string[]>,
): SweptRecord[] {
  const { levels, unordered } = buildDepthLevels(
    swept,
    ({ node }) => node.id,
    ({ node }) => edgesById.get(node.id) ?? [],
  );
  return [...unordered, ...levels.reverse().flat()];
}

function collectDependencies(
  node: StateNode,
  edgesById: Map<string, string[]>,
): string[] {
  const found = new Set<string>();
  const pending = [
    ...(node.dependsOn ?? []),
    ...(edgesById.get(node.id) ?? []),
  ];
  while (pending.length > 0) {
    const id = pending.pop()!;
    const edges = edgesById.get(id);
    if (found.has(id) || id === node.id || !edges) continue;
    found.add(id);
    pending.push(...edges);
  }
  return [...found].sort();
}
