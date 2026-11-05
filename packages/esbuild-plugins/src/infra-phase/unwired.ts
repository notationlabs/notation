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
  /**
   * The local module that imports `factory`, when it isn't `file` itself but
   * a module that `file` imports, such as a helper that calls `lambda()`.
   */
  via?: string;
};

/**
 * Finds the files that look like runtime modules but that nothing deploys.
 * A file is reported when all of these are true:
 *
 * - It matches the `runtimeModules` globs.
 * - It imports a package, such as `@notation/aws/lambda`, with
 *   `type: "infra"`, as a module that calls `lambda()` does. The import can
 *   also be in a helper that it imports without an attribute, such as one
 *   that calls `lambda()` and exports its `handle`. Helpers that are runtime
 *   modules themselves aren't searched: a test that imports a wired module
 *   isn't reported.
 * - No infra module imports it with `type: "runtime"`.
 * - No wired runtime module imports it, directly or through other modules.
 *
 * The infra phase never runs such a file, so its functions aren't declared.
 */
export async function findUnwiredRuntimeModules(
  opts: UnwiredOptions,
): Promise<UnwiredModule[]> {
  const reached = await reachableFrom(opts.wired, opts);
  const unwired: UnwiredModule[] = [];
  for (const file of [...opts.files].sort()) {
    if (reached.has(file) || !isScript(file)) continue;
    if (!matchesRuntimeModules(file, opts.runtimeModules)) continue;
    const found = await infraPackageImport(file, opts, opts.wired);
    if (found) {
      unwired.push(
        found.file === file
          ? { file, factory: found.factory }
          : { file, factory: found.factory, via: found.file },
      );
    }
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

// The first package that `root`, or a helper that it imports without an
// attribute, imports with `type: "infra"`, and the module that imports it. A
// helper is a local module that isn't a runtime module. Modules are searched
// breadth-first, so `root`'s own import comes first.
async function infraPackageImport(
  root: string,
  opts: Pick<UnwiredOptions, "getFile" | "resolve" | "runtimeModules">,
  wired: string[],
): Promise<{ file: string; factory: string } | undefined> {
  const queue = [root];
  const seen = new Set(queue);
  for (const file of queue) {
    const source = await readOrUndefined(file, opts.getFile);
    if (source === undefined) continue;
    const info = parseModule(file, source);
    for (const entry of info.imports) {
      if (entry.attribute !== "infra") continue;
      const target = await resolveOrUndefined(entry.source, file, opts.resolve);
      if (target && !target.local) return { file, factory: entry.source };
    }
    const local = [...info.imports, ...info.reExports, ...info.starExports];
    for (const entry of local) {
      if (entry.attribute !== undefined) continue;
      const target = await resolveOrUndefined(entry.source, file, opts.resolve);
      if (!target?.local || !isScript(target.path)) continue;
      if (seen.has(target.path) || wired.includes(target.path)) continue;
      if (matchesRuntimeModules(target.path, opts.runtimeModules)) continue;
      seen.add(target.path);
      queue.push(target.path);
    }
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

/**
 * Whether a project walk skips a directory: one whose name starts with a dot,
 * `node_modules` or `dist`. They never hold runtime modules, or are too large
 * to walk.
 */
export function isSkippedDirectory(name: string): boolean {
  return name.startsWith(".") || name === "node_modules" || name === "dist";
}

/** Whether a project walk lists a file: a script that isn't a declaration file. */
export function isProjectScript(name: string): boolean {
  return isScript(name) && !/\.d\.[cm]?ts$/.test(name);
}

/**
 * The files under the project root that `isProjectScript` accepts, as
 * absolute paths, sorted. Directories that `isSkippedDirectory` accepts are
 * skipped, and so are directories that can't be read.
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
        if (!isSkippedDirectory(entry.name)) await walk(full);
      } else if (entry.isFile() && isProjectScript(entry.name)) {
        files.push(full);
      }
    }
  };
  await walk(root);
  return files.sort();
}
