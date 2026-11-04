import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { projectRoot } from "@notation/core";
import { parseModule } from "src/infra-phase/module-info";
import type { Resolved } from "src/infra-phase/strip";
import { matchesRuntimeModules } from "src/runtime-modules";
import { isScript } from "src/utils/script";

export type UnwiredOptions = {
  /** Absolute paths of the files that may be runtime modules. */
  files: string[];
  runtimeModules: string[];
  /** The runtime modules that infra imports with `type: "runtime"`. */
  wired: string[];
  getFile: (file: string) => string | Promise<string>;
  resolve: (specifier: string, importer: string) => Promise<Resolved>;
};

export type UnwiredModule = {
  file: string;
  /** The package that the module imports with `type: "infra"`. */
  factory: string;
};

/**
 * Finds the files that look like runtime modules that nothing deploys. Such a
 * file matches the `runtimeModules` globs, and imports a package, such as
 * `@notation/aws/lambda`, with `type: "infra"`, as a module that calls
 * `lambda()` does. No infra module imports it with `type: "runtime"`, and no
 * module that a wired runtime module imports, directly or not, imports it.
 * The infra phase never runs it, so its functions aren't declared.
 */
export async function findUnwiredRuntimeModules(
  opts: UnwiredOptions,
): Promise<UnwiredModule[]> {
  const reached = await reachableFrom(opts.wired, opts);
  const unwired: UnwiredModule[] = [];
  for (const file of [...opts.files].sort()) {
    if (reached.has(file) || !isScript(file)) continue;
    if (!matchesRuntimeModules(file, opts.runtimeModules)) continue;
    const factory = await infraPackageImport(file, opts);
    if (factory) unwired.push({ file, factory });
  }
  return unwired;
}

// The local modules that `roots` import, following imports and re-exports
// without an attribute, and the roots themselves.
async function reachableFrom(
  roots: string[],
  opts: Pick<UnwiredOptions, "getFile" | "resolve">,
): Promise<Set<string>> {
  const reached = new Set<string>();
  const visit = async (file: string): Promise<void> => {
    if (reached.has(file)) return;
    reached.add(file);
    const source = await readOrUndefined(file, opts.getFile);
    if (source === undefined) return;
    const info = parseModule(file, source);
    const sources = [
      ...info.imports,
      ...info.reExports,
      ...info.starExports,
    ].filter((entry) => entry.attribute === undefined);
    for (const { source: specifier } of sources) {
      const target = await resolveOrUndefined(specifier, file, opts.resolve);
      if (target?.local && isScript(target.path)) await visit(target.path);
    }
  };
  for (const root of roots) await visit(root);
  return reached;
}

async function infraPackageImport(
  file: string,
  opts: Pick<UnwiredOptions, "getFile" | "resolve">,
): Promise<string | undefined> {
  const source = await readOrUndefined(file, opts.getFile);
  if (source === undefined) return undefined;
  for (const entry of parseModule(file, source).imports) {
    if (entry.attribute !== "infra") continue;
    const target = await resolveOrUndefined(entry.source, file, opts.resolve);
    if (target && !target.local) return entry.source;
  }
  return undefined;
}

async function readOrUndefined(
  file: string,
  getFile: UnwiredOptions["getFile"],
): Promise<string | undefined> {
  try {
    return await getFile(file);
  } catch {
    return undefined;
  }
}

async function resolveOrUndefined(
  specifier: string,
  importer: string,
  resolve: UnwiredOptions["resolve"],
): Promise<Resolved | undefined> {
  try {
    return await resolve(specifier, importer);
  } catch {
    return undefined;
  }
}

// Directories that never hold runtime modules, or that are too large to walk.
const skippedDirectories = new Set(["node_modules", "dist", ".git"]);

/**
 * The script files under the project root, as absolute paths. Directories
 * whose names start with a dot are skipped, as are `node_modules` and `dist`,
 * and directories that can't be read.
 */
export async function listProjectScripts(
  root: string = projectRoot(),
): Promise<string[]> {
  const files: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".") || skippedDirectories.has(entry.name)) {
          continue;
        }
        await walk(full);
      } else if (entry.isFile() && isScript(entry.name)) {
        files.push(full);
      }
    }
  };
  await walk(root);
  return files;
}
