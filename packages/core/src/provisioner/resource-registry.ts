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
 * The packages that a state record written before provider packages were
 * recorded is assumed to come from.
 */
export const legacyProviderPackages = [
  "@notation/aws.iac",
  "@notation/std.iac",
];

export type ProviderPackage = {
  name: string;
  /**
   * Whether the package is only a guess for records that name no provider. A
   * project need not install such a package, so a failed resolve of it is
   * not reported.
   */
  fallback: boolean;
};

/**
 * The provider packages of the records whose type has no class in code,
 * sorted by name. Only such a record needs a class from its package: deploy
 * and destroy delete it as an orphan, and plan finds its delete cascades.
 */
export function stateProviderPackages(
  nodes: Pick<StateNode, "type" | "provider">[],
  resources: Pick<BaseResource, "type">[] = [],
): ProviderPackage[] {
  const typesInCode = new Set<string>(resources.map((r) => r.type));
  const packages = new Map<string, ProviderPackage>();
  for (const node of nodes) {
    if (typesInCode.has(node.type)) continue;
    if (node.provider) {
      packages.set(node.provider, { name: node.provider, fallback: false });
      continue;
    }
    for (const name of legacyProviderPackages) {
      if (!packages.has(name)) packages.set(name, { name, fallback: true });
    }
  }
  return [...packages.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export type ProviderLoadFailure = Omit<
  ProviderLoadFailedEvent,
  "level" | "event"
>;

/**
 * Registers the `resourceClasses` of each package, so that deploy and destroy
 * can delete a record whose type is no longer in the graph. A package that
 * exports no `resourceClasses` is skipped. A package that can't be resolved
 * or imported is skipped and returned in `failures`, and its records are left
 * in place. A fallback package that can't be resolved is skipped silently.
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
  packages: ProviderPackage[],
  root: string = projectRoot(),
): Promise<{ registry: ResourceRegistry; failures: ProviderLoadFailure[] }> {
  const resolvers = projectResolvers(root);
  const classes: ResourceClass<any, any, any>[] = [];
  const failures: ProviderLoadFailure[] = [];
  for (const { name, fallback } of packages) {
    const entry = resolveFrom(resolvers, name);
    if (!entry) {
      if (!fallback) {
        failures.push({
          provider: name,
          reason: "not-resolved",
          errorMessage: `Could not resolve ${name} from ${root} or its dependencies`,
        });
      }
      continue;
    }
    let provider: { resourceClasses?: unknown };
    try {
      provider = await import(pathToFileURL(entry).href);
    } catch (error) {
      failures.push({
        provider: name,
        reason: "import-failed",
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    if (Array.isArray(provider.resourceClasses)) {
      classes.push(...provider.resourceClasses);
    }
  }
  return { registry: createResourceRegistry(classes), failures };
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

/**
 * Registers the classes of the provider packages that state names, for plan.
 * Emits a warning for each package that fails to load.
 */
export async function loadPlanProviderRegistry(
  state: StateBackend,
  resources: BaseResource[],
  emit: ReconcilerEventEmitter,
): Promise<ResourceRegistry> {
  const { registry, failures } = await loadProviderRegistry(
    stateProviderPackages(await state.values(), resources),
  );
  for (const failure of failures) await emit(loadFailedEvent(failure));
  return registry;
}

/**
 * Registers the classes of the provider packages that state names, for deploy
 * and destroy. Emits a warning for each package that fails to load, once per
 * execution.
 */
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
      () => emit(loadFailedEvent(failure)),
    );
  }
  return registry;
}

function loadFailedEvent(
  failure: ProviderLoadFailure,
): ProviderLoadFailedEvent {
  return {
    level: "warn",
    event: "reconciler.provider.load-failed",
    ...failure,
  };
}
