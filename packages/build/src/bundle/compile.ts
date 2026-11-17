import fs from "node:fs";
import path from "node:path";
import { zipSync } from "fflate";
import { rolldown } from "rolldown";
import {
  configPath,
  loadProject,
  projectRoot,
  resolveModuleGlobs,
  type ModuleGlobs,
} from "@notation/core";
import { ModuleAnalyses } from "../modules";
import { functionBuildOptions } from "../options";
import { bundlePlugin } from "../plugins";
import type { PlatformName } from "../platforms";
import { collectInputs, modifiedSince, sha256Base64 } from "./inputs";

export type BundleSource = {
  /** Names the bundle in errors, such as `bundle:router`. */
  label: string;
  platform: PlatformName;
  /** A key of `modules`, or a path relative to the project root. */
  entry: string;
  modules: Record<string, string>;
  /** The real path of the project root. */
  root: string;
  /** The export names that the build must keep. */
  exports: string[];
};

export type BuiltBundle = {
  code: string;
  /** The bytes of the file that the bundle writes: the code, or a zip of it. */
  file: Uint8Array;
  /** The base64 SHA-256 of `file`. */
  fileSha256: string;
  /** The inputs of the build, as `collectInputs` returns them. */
  files: Record<string, string>;
  /**
   * Whether no input was modified during the build. If one was, `files` can
   * hold hashes of contents that the build didn't read.
   */
  settled: boolean;
};

/** The name of the built module, in the zip for Node. */
export const moduleFileName = "index.mjs";

/**
 * Builds a bundle in memory. Fails if the output renders an infra module of
 * the project or an infra function of a package, or if it doesn't export
 * each name in `source.exports`.
 */
export async function buildBundle(source: BundleSource): Promise<BuiltBundle> {
  const { label, platform, entry, modules, root } = source;
  const started = Date.now();
  const { input, output } = functionBuildOptions(platform, root);
  const analyses = new ModuleAnalyses({ files: await projectGlobs(), root });
  let moduleIds: string[] = [];
  const build = await rolldown({
    ...input,
    // The real path, as Rolldown gives the real paths of the modules that
    // the entry imports.
    input: Object.hasOwn(modules, entry)
      ? entry
      : fs.realpathSync(path.resolve(projectRoot(), entry)),
    // The bundle's plugin comes first, so that a key of `modules` resolves
    // to its module before a platform plugin resolves it, as workerd's does
    // for the name of a Node built-in.
    plugins: [
      bundlePlugin({
        label,
        platform,
        modules,
        analyses,
        onModuleIds: (ids) => (moduleIds = ids),
      }),
      input.plugins,
    ],
  });
  let chunks;
  try {
    ({ output: chunks } = await build.generate(output));
  } finally {
    await build.close();
  }
  if (chunks.length !== 1) {
    throw new Error(
      `${label} built ${chunks.length} files: ${chunks.map((chunk) => chunk.fileName).join(", ")}. A bundle can only be one JavaScript module.`,
    );
  }
  const [chunk] = chunks;
  const missing = source.exports.filter(
    (name) => !chunk.exports.includes(name),
  );
  if (missing.length > 0) {
    throw new Error(
      `${label} doesn't export ${missing.join(", ")}: the module that Rolldown built from the entry ${entry} doesn't export these names, though the entry's source does.`,
    );
  }
  const code = chunk.code;
  const file =
    platform === "node"
      ? // Fixed options, as for std.fs.Zip, so the zip is the same for the
        // same code.
        zipSync(
          { [moduleFileName]: new TextEncoder().encode(code) },
          { level: 9, mtime: "0/0/00 00:00 PM" },
        )
      : new TextEncoder().encode(code);
  const files = collectInputs(moduleIds, root);
  return {
    code,
    file,
    fileSha256: sha256Base64(file),
    files,
    settled: !modifiedSince(files, root, started),
  };
}

const globs = new Map<string, Promise<ModuleGlobs>>();

// The globs of `files` in the project's config, which give the check for
// infra code the kinds of the project's files. A project without a config
// has the default globs.
export function projectGlobs(): Promise<ModuleGlobs> {
  const file = configPath();
  let found = globs.get(file);
  if (!found) {
    found = fs.existsSync(file)
      ? loadProject().then((project) => resolveModuleGlobs(project.config))
      : Promise.resolve({});
    globs.set(file, found);
  }
  return found;
}
