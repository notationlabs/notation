import fs from "node:fs";
import path from "node:path";
import type { Plugin } from "rolldown";
import type { ModuleAnalyses } from "./plugins";

const entryId = "notation:infra-entry";
const resolvedEntryId = `\0${entryId}`;

/** The input to give an infra build that uses `infraEntryPlugin`. */
export const infraEntry = entryId;

// The directories that neither the runtime file scan nor the infra watcher
// enters, at any depth: build output, packages, and dot-directories such as
// .notation/, where deploy writes its state.
const ignoredNames = ["dist", "node_modules"];
const isIgnoredDirectory = (name: string) =>
  ignoredNames.includes(name) || name.startsWith(".");

const escapeRegExp = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The `watch.exclude` pattern for an infra build that uses
 * `infraEntryPlugin`. It matches a path under `root` that passes through a
 * directory that `findRuntimeDeclarations` skips. Rolldown takes only
 * strings and regular expressions here, not a function.
 */
export function infraWatchExclude(root: string): RegExp {
  const separator = String.raw`[\\/]`;
  const segment = String.raw`[^\\/]+`;
  const ignored = `(?:${ignoredNames.join("|")}|${String.raw`\.[^\\/]+`})`;
  return new RegExp(
    `^${escapeRegExp(root)}${separator}(?:${segment}${separator})*${ignored}(?:${separator}|$)`,
  );
}

export type FindRuntimeDeclarationsOptions = {
  analyses: ModuleAnalyses;
  /** Absolute path that the globs are relative to. */
  root: string;
  globs: string[];
};

/**
 * Finds the runtime files that call a declaration function, such as
 * `$lambda`. Returns their absolute paths, sorted. A file that can't be
 * analysed throws an error that names the file.
 */
export function findRuntimeDeclarations({
  analyses,
  root,
  globs,
}: FindRuntimeDeclarationsOptions): string[] {
  return fs
    .globSync(globs, {
      cwd: root,
      exclude: (file) => isIgnoredDirectory(path.basename(file)),
    })
    .map((file) => path.resolve(root, file))
    .filter((file) => analyse(analyses, root, file)?.declaration)
    .sort();
}

function analyse(analyses: ModuleAnalyses, root: string, file: string) {
  try {
    return analyses.fromFile(file);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const relative = path.relative(root, file).split(path.sep).join("/");
    throw new Error(
      `${relative} matches runtimeModules, but it can't be analysed: ${message.replace(`${file}: `, "")}`,
      { cause: error },
    );
  }
}

// The directories to watch for new runtime files: the part of each glob
// before its first segment with a glob character. If that directory doesn't
// exist yet, its nearest existing parent is watched, but not a directory
// above the root, so that creating runtime/ during watch is seen.
function globBases(root: string, globs: string[]): string[] {
  const bases = new Set<string>();
  for (const glob of globs) {
    const segments = glob.split(/[\\/]/);
    const first = segments.findIndex((segment) => /[*?[\]{}()!]/.test(segment));
    let base = path.resolve(
      root,
      ...(first === -1 ? segments.slice(0, -1) : segments.slice(0, first)),
    );
    while (
      !fs.existsSync(base) &&
      base !== root &&
      base !== path.dirname(base)
    ) {
      base = path.dirname(base);
    }
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
 * rebuild. The watch options must exclude `infraWatchExclude(root)`, or
 * each build's output in `dist/` starts another build.
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
