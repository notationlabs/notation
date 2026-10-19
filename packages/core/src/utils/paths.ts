import fs from "node:fs";
import path from "node:path";

const findRoot = (dir: string): string => {
  if (fs.existsSync(path.join(dir, "package.json"))) return dir;
  if (dir === path.dirname(dir)) return process.cwd();
  return findRoot(path.dirname(dir));
};

const projectRoot = findRoot(process.cwd());

/** An absolute path from one relative to the project root. */
export const fromProjectRoot = (p: string) => path.resolve(projectRoot, p);

/** A path relative to the project root, with forward slashes. */
export const toProjectRoot = (p: string) =>
  path.relative(projectRoot, path.resolve(p)).split(path.sep).join("/");

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
};
