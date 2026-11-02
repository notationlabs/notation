import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import esbuild from "esbuild";
import { configPath, filePaths } from "src/utils/paths";
import { parseConfig, type NotationConfig } from "./config";

/**
 * A loaded project. The project root is not stored here: every path resolves
 * against `projectRoot()`, so there is one source for it.
 */
export type Project = {
  config: NotationConfig;
};

/**
 * Loads the project's config: the file given to `setConfigFile`, or else the
 * `notation.config.ts` of the working directory's project. The config is bundled
 * to a temporary file under `node_modules/.cache/notation`, so its imports
 * resolve against the project's node_modules, and the file is deleted once
 * imported.
 */
export async function loadProject(): Promise<Project> {
  const file = configPath();
  try {
    await fs.access(file);
  } catch {
    throw new Error(`Config file not found: ${file}`);
  }
  const outfile = filePaths.configBundle();
  try {
    await esbuild.build({
      entryPoints: [file],
      outfile,
      bundle: true,
      format: "esm",
      platform: "node",
      packages: "external",
      logLevel: "silent",
    });
    const module = await import(pathToFileURL(outfile).href);
    return { config: parseConfig(module.default, path.basename(file)) };
  } finally {
    await fs.rm(outfile, { force: true });
  }
}
