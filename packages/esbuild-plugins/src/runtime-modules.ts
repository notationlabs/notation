import path from "node:path";
import { minimatch } from "minimatch";
import { toProjectRoot } from "@notation/core";

/** Globs, relative to the project root, that never hold runtime modules. */
export const runtimeModulesIgnore = ["**/node_modules/**", "dist/**"];

/**
 * Whether a file matches one of the runtime-module globs. Globs are relative
 * to the project root. Files outside the project root, and files matched by
 * `runtimeModulesIgnore`, never match.
 * @param filePath An absolute path.
 */
export function matchesRuntimeModules(filePath: string, globs: string[]) {
  const relativePath = toProjectRoot(filePath);
  if (relativePath.startsWith("../") || path.isAbsolute(relativePath)) {
    return false;
  }
  if (runtimeModulesIgnore.some((glob) => minimatch(relativePath, glob))) {
    return false;
  }
  return globs.some((glob) => minimatch(relativePath, glob));
}
