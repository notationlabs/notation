import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  createResourceRegistry,
  createResourceRegistryFromResources,
  mergeResourceRegistries,
  resolveResourceClass,
  type ResourceRegistry,
} from "@notation/reconciler";
import type { ResourceClass } from "@notation/resource";
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

/** The packages whose `resourceClasses` deploy and destroy register. */
export const providerPackages = ["@notation/std.iac", "@notation/aws.iac"];

/**
 * Registers the `resourceClasses` of each provider package that the project
 * has installed, so that deploy and destroy can delete a record whose type
 * is no longer in the graph. A package that is not installed, or that is too
 * old to export `resourceClasses`, is skipped.
 *
 * Each package is imported from the project's node_modules, as the infra
 * bundle imports it, and not from core's own dependencies: core does not
 * depend on the providers, which depend on core.
 */
export async function loadProviderRegistry(
  root: string = projectRoot(),
): Promise<ResourceRegistry> {
  const classes: ResourceClass<any, any, any>[] = [];
  for (const name of providerPackages) {
    const entry = findPackageEntry(name, root);
    if (!entry) continue;
    const provider = await import(pathToFileURL(entry).href);
    if (Array.isArray(provider.resourceClasses)) {
      classes.push(...provider.resourceClasses);
    }
  }
  return createResourceRegistry(classes);
}

// Node can't resolve a package from another directory under the `import`
// condition without a flag, so the package's ESM entry is found by hand, in
// the way the infra build finds installed packages.
function findPackageEntry(name: string, root: string): string | undefined {
  for (let dir = path.resolve(root); ; dir = path.dirname(dir)) {
    const packageDir = path.join(dir, "node_modules", name);
    const manifest = path.join(packageDir, "package.json");
    if (fs.existsSync(manifest)) {
      const pkg = JSON.parse(fs.readFileSync(manifest, "utf8"));
      return path.join(packageDir, packageEntry(pkg));
    }
    if (dir === path.dirname(dir)) return undefined;
  }
}

function packageEntry(pkg: { exports?: unknown; main?: string }): string {
  const root =
    typeof pkg.exports === "object" && pkg.exports !== null
      ? (pkg.exports as Record<string, unknown>)["."]
      : pkg.exports;
  if (typeof root === "string") return root;
  if (typeof root === "object" && root !== null) {
    const conditions = root as Record<string, unknown>;
    const entry = conditions.import ?? conditions.default;
    if (typeof entry === "string") return entry;
  }
  return pkg.main ?? "index.js";
}
