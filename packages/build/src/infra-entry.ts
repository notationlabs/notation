import fs from "node:fs";
import path from "node:path";
import type { Plugin } from "rolldown";
import { globCharacters, ignoredGlobs } from "./files";
import type { ModuleAnalyses } from "./modules";

/** The input to give an infra build that uses `infraEntryPlugin`. */
export const infraEntry = "notation:infra-entry";
const resolvedInfraEntry = `\0${infraEntry}`;

/**
 * The `watch.exclude` globs for an infra build that uses `infraEntryPlugin`.
 * They match the directories that the runtime file scan skips.
 */
export const infraWatchExclude = ignoredGlobs;

function analyse(analyses: ModuleAnalyses, file: string) {
  try {
    return analyses.fromFile(file);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${analyses.show(file)} matches files.runtime, but it can't be analysed: ${message}`,
      { cause: error },
    );
  }
}

// The directories to watch for new runtime files: the part of each glob
// before its first segment with a glob character. If that directory doesn't
// exist yet, its nearest existing parent is watched, but not a directory
// above the root, so that creating runtime/ during watch is seen. A glob
// with no glob characters, such as `jobs`, comes with `jobs/**`. Its own
// base would be the folder that holds `jobs`, so it is left out, and the base
// of `jobs/**` covers it.
function globBases(root: string, globs: string[]): string[] {
  const bases = new Set<string>();
  const all = new Set(globs);
  for (const glob of globs) {
    if (all.has(`${glob}/**`)) continue;
    const segments = glob.split(/[\\/]/);
    const first = segments.findIndex((segment) => globCharacters.test(segment));
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
 * each file that `files.runtime` matches and that calls a declaration
 * function, such as `$lambda`, so that a function is deployed even if infra
 * doesn't import its module. ES modules run once, so a module that the infra
 * entry already imports doesn't run again. A runtime file that can't be
 * analysed fails the build, and so does a file that two kinds match.
 *
 * The files are found again on each build. In watch mode, the base
 * directory of each `files.runtime` glob is watched, so that a new runtime
 * file starts a rebuild. The watch options must exclude `infraWatchExclude`,
 * or each build's output in `dist/` starts another build.
 */
export function infraEntryPlugin(options: {
  analyses: ModuleAnalyses;
  /** Absolute path of the infra entry in the config. */
  entryPoint: string;
}): Plugin {
  const { analyses, entryPoint } = options;
  const { files } = analyses;
  return {
    name: "notation-infra-entry",
    resolveId(source) {
      return source === infraEntry ? resolvedInfraEntry : null;
    },
    load(id) {
      if (id !== resolvedInfraEntry) return null;
      if (this.meta.watchMode) {
        for (const dir of globBases(
          files.root,
          files.includedPatterns("runtime"),
        )) {
          this.addWatchFile(dir);
        }
      }
      files.checkOverlaps();
      const runtime = files
        .list("runtime")
        .filter((file) => analyse(analyses, file)?.declaration);
      return [entryPoint, ...runtime]
        .map((file) => `import ${JSON.stringify(file)};\n`)
        .join("");
    },
  };
}
