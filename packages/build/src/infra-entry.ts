import fs from "node:fs";
import path from "node:path";
import type { Plugin } from "rolldown";
import type { ModuleAnalyses } from "./plugins";

const entryId = "notation:infra-entry";
const resolvedEntryId = `\0${entryId}`;

/** The input to give an infra build that uses `infraEntryPlugin`. */
export const infraEntry = entryId;

export type FindRuntimeDeclarationsOptions = {
  analyses: ModuleAnalyses;
  /** Absolute path that the globs are relative to. */
  root: string;
  globs: string[];
};

/**
 * Finds the runtime files that call a declaration function, such as
 * `$lambda`. Returns their absolute paths, sorted. A file that can't be
 * analysed throws.
 */
export function findRuntimeDeclarations({
  analyses,
  root,
  globs,
}: FindRuntimeDeclarationsOptions): string[] {
  return fs
    .globSync(globs, {
      cwd: root,
      exclude: (file) => /(^|[\\/])(node_modules|dist)$/.test(file),
    })
    .map((file) => path.resolve(root, file))
    .filter((file) => analyses.fromFile(file)?.declaration)
    .sort();
}

// The directories to watch for new runtime files: the part of each glob
// before its first segment with a glob character. A directory that doesn't
// exist is skipped.
function globBases(root: string, globs: string[]): string[] {
  const bases = new Set<string>();
  for (const glob of globs) {
    const segments = glob.split(/[\\/]/);
    const first = segments.findIndex((segment) => /[*?[\]{}()!]/.test(segment));
    const base = path.resolve(
      root,
      ...(first === -1 ? segments.slice(0, -1) : segments.slice(0, first)),
    );
    if (fs.existsSync(base)) bases.add(base);
  }
  return [...bases];
}

export type InfraEntryPluginOptions = {
  analyses: ModuleAnalyses;
  /** Absolute path of the infra entry in the config. */
  entryPoint: string;
  /** Absolute path that the globs are relative to. */
  root: string;
  /** Globs for the runtime files. */
  runtimeModules: string[];
};

/**
 * Generates the infra build's entry. It imports the infra entry first, then
 * each runtime file that holds a declaration, so that a function is deployed
 * even if infra doesn't import its module. ES modules run once, so a module
 * that the infra entry already imports doesn't run again.
 *
 * The runtime files are found again on each build. In watch mode, the base
 * directory of each glob is watched, so that a new runtime file starts a
 * rebuild. The watch options must exclude `dist/` if a base directory
 * contains it, or each build's output starts another build.
 */
export function infraEntryPlugin({
  analyses,
  entryPoint,
  root,
  runtimeModules,
}: InfraEntryPluginOptions): Plugin {
  return {
    name: "notation-infra-entry",
    resolveId(source) {
      return source === entryId ? resolvedEntryId : null;
    },
    load(id) {
      if (id !== resolvedEntryId) return null;
      if (this.meta.watchMode) {
        for (const dir of globBases(root, runtimeModules)) {
          this.addWatchFile(dir);
        }
      }
      const files = findRuntimeDeclarations({
        analyses,
        root,
        globs: runtimeModules,
      }).filter((file) => file !== entryPoint);
      return [entryPoint, ...files]
        .map((file) => `import ${JSON.stringify(file)};\n`)
        .join("");
    },
  };
}
