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
import { isResourceClass, type ResourceClass } from "@notation/resource";
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

// Records whose type is in code use the class from code, so only the other
// records need their package loaded.
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

// Packages are resolved from the project, because core does not depend on
// them. Under pnpm, a provider package is often a dependency of a dependency
// and is not linked into the project's node_modules, so the dependency tree is
// searched as well.
export async function loadProviderRegistry(
  packages: string[],
  root: string = projectRoot(),
): Promise<{
  registry: ResourceRegistry;
  failures: ProviderLoadFailedEvent[];
}> {
  const require = createRequire(path.join(root, "package.json"));
  const dirs = cachedDependencyDirs(root);
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
    // Paths are rejected, so that state can't import any file.
    if (!packageSpecifier.test(name)) {
      fail(name, `${name} is not a package name or subpath`);
      continue;
    }
    let entry: string;
    try {
      entry = resolvePackage(require, name, dirs);
    } catch (error) {
      fail(
        name,
        `Could not resolve ${name} from ${root} or its dependencies: ` +
          errorMessage(error),
      );
      continue;
    }
    let found: ResourceClass<any, any, any>[];
    try {
      found = resourceClassesIn(await import(pathToFileURL(entry).href));
    } catch (error) {
      fail(name, errorMessage(error));
      continue;
    }
    if (found.length === 0) {
      fail(name, `${name} exports no resource classes`);
      continue;
    }
    classes.push(...found);
  }
  return { registry: createResourceRegistry(classes), failures };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Tries the project root, then the dependency tree. MODULE_NOT_FOUND means
// try the next directory. Any other error means the package was found but
// can't be loaded, so it is thrown.
function resolvePackage(
  require: NodeJS.Require,
  name: string,
  dependencyDirs: () => Iterable<string>,
): string {
  let notFound: unknown;
  try {
    return require.resolve(name);
  } catch (error) {
    if (!isNotFound(error)) throw error;
    notFound = error;
  }
  for (const dir of dependencyDirs()) {
    try {
      return require.resolve(name, { paths: [dir] });
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
  throw notFound;
}

// A package name, with an optional subpath such as @notation/aws/resources.
// Each segment is limited to word characters, "." "~" and "-", and does not
// start with a dot, so that state can't name a path.
const segment = "[\\w~-][\\w.~-]*";
const packageSpecifier = new RegExp(`^@?${segment}(/${segment})*$`);

// Reads the resource classes among the exports and among the values of each
// exported namespace. import() of a CommonJS module puts its exports under
// default.
function resourceClassesIn(module: Record<string, unknown>) {
  const root = isObject(module.default) ? module.default : module;
  return Object.values(root)
    .flatMap((value) => (isObject(value) ? Object.values(value) : [value]))
    .filter(isResourceClass);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// Shares one walk of the tree between the packages of one load.
function cachedDependencyDirs(root: string): () => Iterable<string> {
  const found: string[] = [];
  const walk = dependencyDirs(root);
  return function* () {
    yield* found;
    for (const dir of walk) {
      found.push(dir);
      yield dir;
    }
  };
}

function isNotFound(error: unknown): boolean {
  return (error as { code?: string }).code === "MODULE_NOT_FOUND";
}

// Real paths are used because pnpm puts a package's dependencies next to its
// real path, not next to its symlink. Dev dependencies are followed for the
// project only.
function* dependencyDirs(root: string): Generator<string> {
  const project = manifestDir(root);
  if (!project) return;
  const seen = new Set<string>();
  const pending = [project];
  for (let dir = pending.shift(); dir; dir = pending.shift()) {
    for (const name of dependencyNames(dir, dir === project)) {
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

// The project root is where notation.config.ts is. The package.json can be in
// a parent directory.
function manifestDir(root: string): string | undefined {
  for (let dir = root; ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
    if (path.dirname(dir) === dir) return undefined;
  }
}

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
  // A step, so that a resumed execution loads the same packages after it has
  // deleted some of the records.
  const packages = yield* step.run("notation:providers", async () =>
    stateProviderPackages(await state.values(), resources),
  );
  // Classes can't be journaled, so a resume imports the packages again. The
  // warnings are steps, so a resume does not repeat them.
  const { registry, failures } = await loadProviderRegistry(packages);
  for (const failure of failures) {
    yield* step.run(
      `notation:providers:${encodeURIComponent(failure.provider)}:emit`,
      () => emit(failure),
    );
  }
  return registry;
}
