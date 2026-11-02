import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { configFileName } from "src/config/config";

/**
 * Finds the project root for a directory: the nearest directory, at or above
 * `dir`, that holds `notation.config.ts`. The search stops at the first
 * directory that holds a `package.json` and no config, so a config in a
 * parent package never claims a nested package. That directory is then the
 * root, so commands can report the missing config. Without either file,
 * `dir` is the root.
 */
export function findProjectRoot(dir: string): string {
  for (let current = path.resolve(dir); ; current = path.dirname(current)) {
    if (fs.existsSync(path.join(current, configFileName))) return current;
    if (fs.existsSync(path.join(current, "package.json"))) return current;
    if (current === path.dirname(current)) return path.resolve(dir);
  }
}

const roots = new Map<string, string>();
let configFile: string | undefined;

/**
 * Uses the config at `file` in place of the one found from the working
 * directory, so the project root becomes the config's directory. `undefined`
 * goes back to searching from the working directory.
 */
export function setConfigFile(file: string | undefined) {
  configFile = file === undefined ? undefined : path.resolve(file);
}

/** The absolute path of the project's config file. */
export function configPath(): string {
  if (configFile !== undefined) return configFile;
  const cwd = process.cwd();
  let root = roots.get(cwd);
  if (root === undefined) {
    root = findProjectRoot(cwd);
    roots.set(cwd, root);
  }
  return path.join(root, configFileName);
}

/**
 * The directory that holds the config. Every path in a project resolves
 * against it: the entry, `dist` and the state database.
 */
export function projectRoot(): string {
  return path.dirname(configPath());
}

/** An absolute path from one relative to the project root. */
export const fromProjectRoot = (p: string) => path.resolve(projectRoot(), p);

/** A path relative to the project root, with forward slashes. */
export const toProjectRoot = (p: string) =>
  path.relative(projectRoot(), path.resolve(p)).split(path.sep).join("/");

const distPath = (entryPoint: string, ext: string) =>
  fromProjectRoot(`dist/${toProjectRoot(entryPoint).replace(/\.[cm]?[jt]sx?$/, ext)}`);

export const filePaths = {
  dist: {
    dir: () => fromProjectRoot("dist"),
    runtime: {
      index: (entryPoint: string) => distPath(entryPoint, "/index.mjs"),
    },
    infra: (entryPoint: string) => distPath(entryPoint, ".mjs"),
  },
  database: () => fromProjectRoot(".notation/workflows.db"),
  // Unique per call, so parallel commands never share the file.
  configBundle: () =>
    fromProjectRoot(
      `node_modules/.cache/notation/config-${process.pid}-${randomUUID()}.mjs`,
    ),
};
