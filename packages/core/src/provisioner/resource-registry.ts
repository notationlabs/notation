import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  createResourceRegistry,
  createResourceRegistryFromResources,
  mergeResourceRegistries,
  resolveResourceClass,
  type ProviderLoadFailedEvent,
  type ReconcilerEventEmitter,
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
 * The provider packages of the records whose type has no class in code,
 * sorted. Only such a record needs a class from its package: deploy and
 * destroy delete it as an orphan, and plan finds its delete cascades.
 */
export function stateProviderPackages(
  nodes: Pick<StateNode, "type" | "provider">[],
  resources: Pick<BaseResource, "type">[] = [],
): string[] {
  const typesInCode = new Set<string>(resources.map((r) => r.type));
  const packages = new Set<string>();
  for (const node of nodes) {
    if (!typesInCode.has(node.type)) packages.add(node.provider);
  }
  return [...packages].sort();
}

/**
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
): Promise<{
  registry: ResourceRegistry;
  failures: ProviderLoadFailedEvent[];
}> {
  const require = createRequire(path.join(root, "package.json"));
  const paths = [root, ...dependencyDirs(root)];
  const classes: ResourceClass<any, any, any>[] = [];
  const failures: ProviderLoadFailedEvent[] = [];
  const fail = (provider: string, errorMessage: string) =>
    failures.push({
      level: "warn",
      event: "reconciler.provider.load-failed",
      provider,
      errorMessage,
    });
  for (const name of packages) {
    let entry: string;
    try {
      entry = require.resolve(name, { paths });
    } catch {
      fail(name, `Could not resolve ${name} from ${root} or its dependencies`);
      continue;
    }
    let provider: { resourceClasses?: unknown };
    try {
      provider = await import(pathToFileURL(entry).href);
    } catch (error) {
      fail(name, error instanceof Error ? error.message : String(error));
      continue;
    }
    if (Array.isArray(provider.resourceClasses)) {
      classes.push(...provider.resourceClasses);
    }
  }
  return { registry: createResourceRegistry(classes), failures };
}

// The real directory of each dependency in the project's package.json. A
// symlink is followed, as Node follows it, so that pnpm's links resolve the
// dependency's own dependencies.
function dependencyDirs(root: string): string[] {
  let manifest: Record<string, Record<string, string> | undefined>;
  try {
    manifest = JSON.parse(
      fs.readFileSync(path.join(root, "package.json"), "utf8"),
    );
  } catch {
    return [];
  }
  const names = Object.keys({
    ...manifest.dependencies,
    ...manifest.devDependencies,
  });
  const dirs: string[] = [];
  for (const name of names) {
    try {
      dirs.push(
        fs.realpathSync(path.join(root, "node_modules", ...name.split("/"))),
      );
    } catch {
      continue;
    }
  }
  return dirs;
}

export async function loadPlanProviderRegistry(
  state: StateBackend,
  resources: BaseResource[],
  emit: ReconcilerEventEmitter,
): Promise<ResourceRegistry> {
  const { registry, failures } = await loadProviderRegistry(
    stateProviderPackages(await state.values(), resources),
  );
  for (const failure of failures) await emit(failure);
  return registry;
}

export async function* loadStateProviderRegistry(
  step: DurableStep,
  state: StateBackend,
  resources: BaseResource[],
  emit: ReconcilerEventEmitter,
): AsyncGenerator<any, ResourceRegistry, any> {
  // A step, so that a resumed execution loads the packages of the records it
  // read the first time, including those of records it has deleted since.
  const packages = yield* step.run("notation:providers", async () =>
    stateProviderPackages(await state.values(), resources),
  );
  // Classes can't be journaled, so a resumed execution imports the packages
  // again. The warnings are steps, so that a resume does not repeat them.
  const { registry, failures } = await loadProviderRegistry(packages);
  for (const failure of failures) {
    yield* step.run(
      `notation:providers:${encodeURIComponent(failure.provider)}:emit`,
      () => emit(failure),
    );
  }
  return registry;
}
