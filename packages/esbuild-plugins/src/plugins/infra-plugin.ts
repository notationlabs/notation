import path from "node:path";
import { Plugin } from "esbuild";
import { filePaths, toProjectRoot } from "@notation/core";
import { createResourceModule } from "src/codegen/codegen";
import { parseRuntimeModule } from "src/parsers/parse-runtime-module";
import { matchesRuntimeModules } from "src/runtime-modules";
import { GetFile, fsGetFile, withFileCheck } from "src/utils/get-file";

/** A runtime module that the infra plugin replaced. */
export type RuntimeModuleEntry = {
  /** The absolute path of the module. */
  path: string;
  /** The module's `resource.service`, such as `aws/lambda`. */
  service: string;
};

type PluginOpts = {
  /** Globs for the files that can be runtime modules. */
  runtimeModules: string[];
  getFile?: GetFile;
  /**
   * Called after each build without errors, with the runtime modules that the
   * build replaced, sorted by path.
   */
  onRuntimeModules?: (modules: RuntimeModuleEntry[]) => void;
};

/**
 * Replaces each runtime module that infra imports with a generated module
 * that declares the module's resource. The runtime module itself is never
 * evaluated in the infra phase. Files that match the globs but don't export
 * `resource` load as ordinary modules.
 */
export function infraPlugin(opts: PluginOpts): Plugin {
  const getFile = withFileCheck(opts.getFile || fsGetFile);
  return {
    name: "notation-infra",
    setup(build) {
      let replaced = new Map<string, RuntimeModuleEntry>();

      build.onStart(() => {
        replaced = new Map();
      });

      build.onLoad(
        { filter: /\.[cm]?[jt]sx?$/, namespace: "file" },
        async (args) => {
          if (!matchesRuntimeModules(args.path, opts.runtimeModules)) return;

          const source = await getFile(args.path);
          const runtimeModule = parseRuntimeModule(
            source,
            toProjectRoot(args.path),
          );
          if (!runtimeModule) return;

          replaced.set(args.path, {
            path: args.path,
            service: runtimeModule.resource.service,
          });
          const codePath = toProjectRoot(
            filePaths.dist.runtime.index(args.path),
          );
          return {
            contents: createResourceModule(runtimeModule, codePath),
            loader: "ts",
            resolveDir: path.dirname(args.path),
            watchFiles: [args.path],
          };
        },
      );

      build.onEnd((result) => {
        if (!opts.onRuntimeModules || result.errors.length > 0) return;
        const modules = [...replaced.values()].sort((a, b) =>
          a.path < b.path ? -1 : 1,
        );
        opts.onRuntimeModules(modules);
      });
    },
  };
}
