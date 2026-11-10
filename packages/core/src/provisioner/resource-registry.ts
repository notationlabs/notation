import fs from "node:fs";
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
 * exports no `resourceClasses` is skipped. A package that can't be resolved is
 * skipped with a warning, and its records are left in place.
 *
 * Core does not depend on the providers, which depend on core, so each
 * package is resolved from the project. The project usually depends on a
 * provider package such as `@notation/aws` and not on the provider package it
 * uses, such as `@notation/aws.iac`. pnpm does not link such a transitive
 * package into the project's `node_modules`, so a package that the project
 * root can't resolve is resolved from each of the project's dependencies, as
 * Node resolves it when a dependency imports it.
 */
export async function loadProviderRegistry(
  packages: string[],
  root: string = projectRoot(),
  warn: (message: string) => void = console.warn,
): Promise<ResourceRegistry> {
  const resolvers = projectResolvers(root);
  const classes: ResourceClass<any, any, any>[] = [];
  for (const name of packages) {
    const entry = resolveFrom(resolvers, name);
    if (!entry) {
      warn(
        `Could not resolve the provider package ${name} from ${root} or its dependencies. Records from this package will not be deleted.`,
      );
      continue;
    }
    const provider = await import(pathToFileURL(entry).href);
    if (Array.isArray(provider.resourceClasses)) {
      classes.push(...provider.resourceClasses);
    }
  }
  return createResourceRegistry(classes);
}

// The project root first, then the real directory of each dependency in the
// project's package.json. A symlink is followed, as Node follows it, so that
// pnpm's links resolve the dependency's own dependencies.
function projectResolvers(root: string): NodeJS.Require[] {
  const manifestPath = path.join(root, "package.json");
  const resolvers = [createRequire(manifestPath)];
  let manifest: Record<string, Record<string, string> | undefined>;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch {
    return resolvers;
  }
  const names = Object.keys({
    ...manifest.dependencies,
    ...manifest.devDependencies,
  });
  for (const name of names) {
    const dir = path.join(root, "node_modules", ...name.split("/"));
    try {
      resolvers.push(
        createRequire(path.join(fs.realpathSync(dir), "package.json")),
      );
    } catch {
      continue;
    }
  }
  return resolvers;
}

function resolveFrom(
  resolvers: NodeJS.Require[],
  name: string,
): string | undefined {
  for (const require of resolvers) {
    try {
      return require.resolve(name);
    } catch {
      continue;
    }
  }
  return undefined;
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
