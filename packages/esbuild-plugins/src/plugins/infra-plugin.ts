import path from "node:path";
import { Plugin } from "esbuild";
import { filePaths, toProjectRoot } from "@notation/core";
import { createResourceModule } from "src/codegen/codegen";
import { parseRuntimeModule } from "src/parsers/parse-runtime-module";
import { matchesRuntimeModules } from "src/runtime-modules";
import { GetFile, fsGetFile, withFileCheck } from "src/utils/get-file";

type PluginOpts = {
  /** Globs for the files that can be runtime modules. */
  runtimeModules: string[];
  getFile?: GetFile;
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
      build.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async (args) => {
        if (!matchesRuntimeModules(args.path, opts.runtimeModules)) return;

        const source = await getFile(args.path);
        const runtimeModule = parseRuntimeModule(
          source,
          toProjectRoot(args.path),
        );
        if (!runtimeModule) return;

        const codePath = toProjectRoot(filePaths.dist.runtime.index(args.path));
        return {
          contents: createResourceModule(runtimeModule, codePath),
          loader: "ts",
          resolveDir: path.dirname(args.path),
          watchFiles: [args.path],
        };
      });
    },
  };
}
