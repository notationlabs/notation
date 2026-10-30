import fs from "node:fs";
import path from "node:path";

const findUp = (dir: string, file: string): string | undefined => {
  if (fs.existsSync(path.join(dir, file))) return dir;
  if (dir === path.dirname(dir)) return undefined;
  return findUp(path.dirname(dir), file);
};

// The project root holds notation.config.ts. Without one, the nearest
// package.json marks it, so commands can still report the missing config.
const projectRoot =
  findUp(process.cwd(), "notation.config.ts") ??
  findUp(process.cwd(), "package.json") ??
  process.cwd();

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
