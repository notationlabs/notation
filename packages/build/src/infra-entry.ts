import fs from "node:fs";
import path from "node:path";
import type { Plugin } from "rolldown";
import type { ModuleAnalyses } from "./plugins";

/** The input to give an infra build that uses `infraEntryPlugin`. */
export const infraEntry = "notation:infra-entry";
const resolvedInfraEntry = `\0${infraEntry}`;

// The directories that neither the runtime file scan nor the infra watcher
// enters, at any depth: build output, packages, and dot-directories such as
// .notation/, where deploy writes its state.
const ignoredNames = ["dist", "node_modules"];
const isIgnoredDirectory = (name: string) =>
  ignoredNames.includes(name) || name.startsWith(".");

/**
 * The `watch.exclude` globs for an infra build that uses `infraEntryPlugin`.
 * They match the directories that the runtime file scan skips.
 */
export const infraWatchExclude = [
  ...ignoredNames.map((name) => `**/${name}/**`),
  "**/.*/**",
];

function analyse(analyses: ModuleAnalyses, root: string, file: string) {
  try {
    return analyses.fromFile(file);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const relative = path.relative(root, file).split(path.sep).join("/");
    throw new Error(
      `${relative} matches runtimeModules, but it can't be analysed: ${message}`,
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

/**
 * Generates the infra build's entry. It imports the infra entry first, then
 * each runtime file that calls a declaration function, such as `$lambda`, so
 * that a function is deployed even if infra doesn't import its module. ES
 * modules run once, so a module that the infra entry already imports doesn't
 * run again. A runtime file that can't be analysed fails the build.
 *
 * The runtime files are found again on each build. In watch mode, the base
 * directory of each glob is watched, so that a new runtime file starts a
 * rebuild. The watch options must exclude `infraWatchExclude`, or each
 * build's output in `dist/` starts another build.
 */
export function infraEntryPlugin(options: {
  analyses: ModuleAnalyses;
  /** Absolute path of the infra entry in the config. */
  entryPoint: string;
  /** Absolute path that the globs are relative to. */
  root: string;
  /** Globs for the runtime files. */
  runtimeModules: string[];
}): Plugin {
  const { analyses, entryPoint, root, runtimeModules } = options;
  return {
    name: "notation-infra-entry",
    resolveId(source) {
      return source === infraEntry ? resolvedInfraEntry : null;
    },
    load(id) {
      if (id !== resolvedInfraEntry) return null;
      if (this.meta.watchMode) {
        for (const dir of globBases(root, runtimeModules)) {
          this.addWatchFile(dir);
        }
      }
      const files = fs
        .globSync(runtimeModules, {
          cwd: root,
          exclude: (file) => isIgnoredDirectory(path.basename(file)),
        })
        .map((file) => path.resolve(root, file))
        .filter((file) => analyse(analyses, root, file)?.declaration)
        .sort();
      return [entryPoint, ...files]
        .map((file) => `import ${JSON.stringify(file)};\n`)
        .join("");
    },
  };
}
