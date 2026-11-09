import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  createResourceRegistry,
  createResourceRegistryFromResources,
  mergeResourceRegistries,
  resolveResourceClass,
  type ResourceRegistry,
} from "@notation/reconciler";
import type { DurableStep } from "@notation/reconciler/durable";
import type { ResourceClass } from "@notation/resource";
import type { StateBackend, StateNode } from "@notation/state";
import type { BaseResource } from "src/orchestrator/resource";
import { projectRoot } from "src/utils/paths";

export {
  createResourceRegistry,
  mergeResourceRegistries,
  resolveResourceClass,
  type ResourceRegistry,
};

export function createResourceRegistryFromGraph(
  resources: BaseResource[],
): ResourceRegistry {
  return createResourceRegistryFromResources(resources);
}

/**
 * The packages that a state record written before provider packages were
 * recorded is assumed to come from.
 */
export const legacyProviderPackages = [
  "@notation/aws.iac",
  "@notation/std.iac",
];

/** The provider packages that the records in state name, sorted. */
export function stateProviderPackages(
  nodes: Pick<StateNode, "provider">[],
): string[] {
  const packages = new Set<string>();
  for (const node of nodes) {
    const names = node.provider ? [node.provider] : legacyProviderPackages;
    for (const name of names) packages.add(name);
  }
  return [...packages].sort();
}

/**
 * Registers the `resourceClasses` of each package, so that deploy and destroy
 * can delete a record whose type is no longer in the graph. A package that
 * can't be resolved, or that exports no `resourceClasses`, is skipped.
 *
 * Each package is resolved from the project root, as the infra bundle
 * resolves it, and not from core's own dependencies: core does not depend on
 * the providers, which depend on core.
 */
export async function loadProviderRegistry(
  packages: string[],
  root: string = projectRoot(),
): Promise<ResourceRegistry> {
  const require = createRequire(path.join(root, "package.json"));
  const classes: ResourceClass<any, any, any>[] = [];
  for (const name of packages) {
    let entry: string;
    try {
      entry = require.resolve(name);
    } catch {
      continue;
    }
    const provider = await import(pathToFileURL(entry).href);
    if (Array.isArray(provider.resourceClasses)) {
      classes.push(...provider.resourceClasses);
    }
  }
  return createResourceRegistry(classes);
}

/** Registers the classes of the provider packages that state names. */
export async function* loadStateProviderRegistry(
  step: DurableStep,
  state: StateBackend,
): AsyncGenerator<any, ResourceRegistry, any> {
  // A step, so that a resumed execution loads the packages of the records it
  // read the first time, including those of records it has deleted since.
  const packages = yield* step.run("notation:providers", async () =>
    stateProviderPackages(await state.values()),
  );
  return loadProviderRegistry(packages);
}
