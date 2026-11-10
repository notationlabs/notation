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
 * A record with no provider package fails, as earlier versions wrote such
 * records and their state is not supported.
 */
export function stateProviderPackages(
  nodes: Pick<StateNode, "id" | "type" | "provider">[],
  resources: Pick<BaseResource, "type">[] = [],
): string[] {
  const typesInCode = new Set<string>(resources.map((r) => r.type));
  const packages = new Set<string>();
  for (const node of nodes) {
    if (typeof node.provider !== "string") {
      throw new Error(
        `The state record of ${node.id} has no provider package. An earlier ` +
          `version of Notation wrote it, and this version does not support ` +
          `its state. Destroy the stack with the earlier version, then ` +
          `deploy it with this one.`,
      );
    }
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
 * root can't resolve is resolved from each package in the project's
 * dependency tree, as Node resolves it when that package imports it.
 */
export async function loadProviderRegistry(
  packages: string[],
  root: string = projectRoot(),
): Promise<{
  registry: ResourceRegistry;
  failures: ProviderLoadFailedEvent[];
}> {
  const require = createRequire(path.join(root, "package.json"));
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
    // A record names a package, and a path in its place would import a file.
    if (name.startsWith(".") || path.isAbsolute(name)) {
      fail(name, `${name} is a path, not a package name`);
      continue;
    }
    let entry: string;
    try {
      entry = resolvePackage(require, name, root);
    } catch (error) {
      fail(
        name,
        `Could not resolve ${name} from ${root} or its dependencies: ` +
          errorMessage(error),
      );
      continue;
    }
    let provider: { resourceClasses?: unknown; default?: unknown };
    try {
      provider = await import(pathToFileURL(entry).href);
    } catch (error) {
      fail(name, errorMessage(error));
      continue;
    }
    // A CommonJS build imported from ESM can put its exports under default.
    const resourceClasses =
      provider.resourceClasses ??
      (provider.default as { resourceClasses?: unknown } | undefined)
        ?.resourceClasses;
    if (!Array.isArray(resourceClasses)) {
      fail(name, `${name} does not export a resourceClasses array`);
      continue;
    }
    if (!resourceClasses.every(isResourceClass)) {
      fail(name, `${name} exports a resourceClasses entry that is not a class`);
      continue;
    }
    classes.push(...resourceClasses);
  }
  return { registry: createResourceRegistry(classes), failures };
}

function isResourceClass(
  value: unknown,
): value is ResourceClass<any, any, any> {
  return (
    typeof value === "function" &&
    typeof (value as { type?: unknown }).type === "string"
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// A package that is found but can't be resolved, such as one with no export
// for the require conditions, fails with the error of the directory it was
// found from. A package found nowhere fails with the project root's error.
// The dependency tree is walked only when the root can't resolve the package,
// and the walk stops at the first directory that can.
function resolvePackage(
  require: NodeJS.Require,
  name: string,
  root: string,
): string {
  let notFound: unknown;
  try {
    return require.resolve(name);
  } catch (error) {
    if (!isNotFound(error)) throw error;
    notFound = error;
  }
  for (const dir of dependencyDirs(root)) {
    try {
      return require.resolve(name, { paths: [dir] });
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
  throw notFound;
}

function isNotFound(error: unknown): boolean {
  return (error as { code?: string }).code === "MODULE_NOT_FOUND";
}

// The real directory of each package in the project's dependency tree,
// breadth first. A symlink is followed, as Node follows it, so that pnpm's
// links resolve each package's own dependencies. The project's dev
// dependencies are included, and those of other packages are not.
function* dependencyDirs(root: string): Generator<string> {
  const seen = new Set<string>();
  const pending = [root];
  for (let dir = pending.shift(); dir; dir = pending.shift()) {
    for (const name of dependencyNames(dir, dir === root)) {
      const found = findPackageDir(dir, name);
      if (!found || seen.has(found)) continue;
      seen.add(found);
      yield found;
      pending.push(found);
    }
  }
}

function dependencyNames(dir: string, includeDev: boolean): string[] {
  let manifest: Record<string, Record<string, string> | undefined>;
  try {
    manifest = JSON.parse(
      fs.readFileSync(path.join(dir, "package.json"), "utf8"),
    );
  } catch {
    return [];
  }
  return Object.keys({
    ...manifest.dependencies,
    ...manifest.optionalDependencies,
    ...(includeDev ? manifest.devDependencies : {}),
  });
}

// Looks in the node_modules of `from` and of each directory above it, as Node
// does.
function findPackageDir(from: string, name: string): string | undefined {
  for (let dir = from; ; dir = path.dirname(dir)) {
    try {
      return fs.realpathSync(
        path.join(dir, "node_modules", ...name.split("/")),
      );
    } catch {
      if (path.dirname(dir) === dir) return undefined;
    }
  }
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
