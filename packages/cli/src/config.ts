import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import esbuild from "esbuild";
import {
  configFileName,
  fromProjectRoot,
  parseConfig,
  resolveDeployment,
  resolveEntryPoint,
  type Deployment,
  type NotationConfig,
} from "@notation/core";

export type LoadConfigOptions = {
  /** The directory that holds the config. Defaults to the project root. */
  root?: string;
};

/**
 * Loads `notation.config.ts` from the project root. The config is bundled to
 * `dist/notation.config.mjs` and imported from there, so its imports resolve
 * against the project's node_modules.
 */
export async function loadConfig(
  opts: LoadConfigOptions = {},
): Promise<NotationConfig> {
  const root = opts.root ?? fromProjectRoot(".");
  const configPath = path.join(root, configFileName);
  if (!fs.existsSync(configPath)) {
    throw new Error(`No ${configFileName} found in ${root}`);
  }
  const outfile = path.join(root, "dist", "notation.config.mjs");
  await esbuild.build({
    entryPoints: [configPath],
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    packages: "external",
    logLevel: "silent",
  });
  // The query busts the module cache, so a long-lived process (watch) reads
  // the config as it is now.
  const module = await import(`${pathToFileURL(outfile).href}?${Date.now()}`);
  return parseConfig(module.default);
}

/** Loads the config and resolves an entry name to its entry file. */
export async function loadEntryPoint(
  entry: string,
  opts: LoadConfigOptions = {},
): Promise<string> {
  return resolveEntryPoint(await loadConfig(opts), entry, opts.root);
}

/**
 * Loads the config and resolves the deployment of an entry to a stage. The
 * stage falls back to the config's `defaultStage`.
 */
export async function loadDeployment(
  target: { entry: string; stage?: string },
  opts: LoadConfigOptions = {},
): Promise<Deployment> {
  return resolveDeployment(await loadConfig(opts), {
    ...target,
    root: opts.root,
  });
}
