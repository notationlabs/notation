import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import esbuild from "esbuild";
import { filePaths, projectRoot } from "src/utils/paths";
import { configFileName, parseConfig, type NotationConfig } from "./config";

/** A project: its root directory and its loaded config. */
export type Project = {
  /** Absolute path of the project root, the directory of the config. */
  root: string;
  config: NotationConfig;
};

/**
 * Loads the project of the current working directory. The config is bundled
 * to a temporary file under `node_modules/.cache/notation`, so its imports
 * resolve against the project's node_modules, and the file is deleted once
 * imported.
 */
export async function loadProject(): Promise<Project> {
  const root = projectRoot();
  const configPath = path.join(root, configFileName);
  try {
    await fs.access(configPath);
  } catch {
    throw new Error(`No ${configFileName} found in ${root}`);
  }
  const outfile = filePaths.configBundle();
  try {
    await esbuild.build({
      entryPoints: [configPath],
      outfile,
      bundle: true,
      format: "esm",
      platform: "node",
      packages: "external",
      logLevel: "silent",
    });
    const module = await import(pathToFileURL(outfile).href);
    return { root, config: parseConfig(module.default) };
  } finally {
    await fs.rm(outfile, { force: true });
  }
}
