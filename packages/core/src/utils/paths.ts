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

/**
 * The project root of the current working directory. Every path in a project
 * resolves against it: the config, the entries, `dist` and the state database.
 */
export function projectRoot(): string {
  const cwd = process.cwd();
  let root = roots.get(cwd);
  if (root === undefined) {
    root = findProjectRoot(cwd);
    roots.set(cwd, root);
  }
  return root;
}

/** An absolute path from one relative to the project root. */
export const fromProjectRoot = (p: string) => path.resolve(projectRoot(), p);

/** A path relative to the project root, with forward slashes. */
export const toProjectRoot = (p: string) =>
  path.relative(projectRoot(), path.resolve(p)).split(path.sep).join("/");

const distPath = (entryPoint: string, ext: string) =>
  fromProjectRoot(`dist/${toProjectRoot(entryPoint).replace(/.ts$/, ext)}`);

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
