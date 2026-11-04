import type { Loader } from "esbuild";

const scriptExtension = /\.[cm]?[jt]sx?$/;

/** Whether a path names a JavaScript or TypeScript module. */
export function isScript(file: string): boolean {
  return scriptExtension.test(file);
}

export function loaderFor(file: string): Loader {
  if (/\.[cm]?tsx$/.test(file)) return "tsx";
  if (/\.[cm]?jsx$/.test(file)) return "jsx";
  if (/\.[cm]?js$/.test(file)) return "js";
  return "ts";
}

/** An export name as it appears in an export or import clause. */
export function exportName(name: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name);
}
