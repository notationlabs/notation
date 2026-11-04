import path from "node:path";
import { toProjectRoot } from "@notation/core";

/**
 * Whether esbuild resolved an import to a file of the project: inside the
 * project root, outside `node_modules`, and not external. Packages, linked
 * workspace packages included, are not local.
 */
export function isLocalModule(result: {
  path: string;
  external?: boolean;
  namespace?: string;
}): boolean {
  if (result.external || (result.namespace ?? "file") !== "file") return false;
  if (result.path.split(path.sep).includes("node_modules")) return false;
  const relative = toProjectRoot(result.path);
  return !relative.startsWith("../") && !path.isAbsolute(relative);
}
