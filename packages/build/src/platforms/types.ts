import type { InputOptions } from "rolldown";
import type { ModuleAnalysis } from "../analyze";

/** A platform that runs the runtime bundle of a declaration module. */
export type Platform = {
  /**
   * The Rolldown input options of the runtime bundle, such as `platform`,
   * `resolve` and `plugins`.
   */
  build: InputOptions;
  /**
   * What the runtime entry re-exports from the module: only the
   * declaration's entry, or also the module's other value exports, for a
   * platform that reads named exports, such as Durable Object classes.
   */
  reexports: "entry" | "module";
  /**
   * Fails for one of `names`, the other exports that the runtime entry
   * re-exports, whose value the platform doesn't start with.
   */
  checkExports?: (analysis: ModuleAnalysis, names: string[]) => void;
};
