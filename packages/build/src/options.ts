import type { InputOptions, OutputOptions } from "rolldown";
import { projectRoot } from "@notation/core";
import { realRoot } from "./files";
import { platformOf, type PlatformName } from "./platforms";

export type FunctionBuildOptions = {
  /** Without `input`. The platform's plugins are in `plugins`. */
  input: InputOptions;
  /** Without `dir` and the file names. */
  output: OutputOptions;
};

/**
 * Returns the full Rolldown options of a function's bundle on a platform,
 * Node by default: the bundle of a `$lambda` or `$worker` module, or a
 * bundle from `bundle()`. The caller adds `input`, its own plugins and the
 * output location.
 *
 * `cwd` is the real path of the project root. Rolldown writes the paths of
 * its region comments relative to `cwd`, so the output is the same on every
 * machine. It is passed as an option, so the process's working directory
 * doesn't change.
 */
export function functionBuildOptions(
  platform: PlatformName | undefined,
  cwd: string = realRoot(projectRoot()),
): FunctionBuildOptions {
  return {
    input: {
      cwd,
      tsconfig: true,
      ...platformOf(platform).build(),
      // Off, so that the bundle check can detect a function that uses a
      // constant from an infra module. The check looks for rendered code
      // from an infra module, and an inlined constant leaves none.
      optimization: { inlineConst: false },
    },
    // One file: a Worker upload sends one module, and the Lambda zip holds
    // one file, so a second chunk from a dynamic import would be lost.
    output: { format: "esm", codeSplitting: false },
  };
}
