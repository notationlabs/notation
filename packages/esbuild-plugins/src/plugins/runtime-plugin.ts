import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Loader, Plugin } from "esbuild";
import { toProjectRoot } from "@notation/core";
import { parseModule } from "src/infra-phase/module-info";
import { moduleKey } from "src/runtime-modules";
import { rewriteRuntimeModule } from "src/runtime-bundle/rewrite";
import { isLocalModule } from "src/utils/is-local";
import { GetFile, fsGetFile, withFileCheck } from "src/utils/get-file";

type PluginOpts = {
  getFile?: GetFile;
  /**
   * Called after each build without errors, with the output keys that each
   * output file reads from infra, such as `infra/orders#orderQueue.url`, by
   * the output file's absolute path. Only reads left after tree-shaking are
   * listed.
   */
  onReads?: (reads: Record<string, string[]>) => void;
};

const internal = Symbol.for("@notation/esbuild-plugins/runtime-internal");
const infraAttribute = /\btype\s*:\s*["']infra["']/;

/** The specifier that rewritten runtime code imports `read` from. */
export const readSpecifier = "notation:read";

/**
 * Bundles a function's runtime code. Each module that imports infra
 * `with { type: "infra" }` is rewritten by `rewriteRuntimeModule`: provider
 * imports become their runtime halves, and each use of a local infra module
 * becomes a read of a value that the function receives when it deploys.
 *
 * Runtime code that imports an infra package, such as `@notation/aws/sqs`,
 * without the attribute fails, since the bundle would include infra.
 */
export function runtimePlugin(opts: PluginOpts = {}): Plugin {
  const getFile = withFileCheck(opts.getFile || fsGetFile);
  return {
    name: "notation-runtime",
    setup(build) {
      if (opts.onReads) build.initialOptions.metafile = true;
      // Every read that a rewrite made. A call in the output counts as a read
      // only if it is one of these.
      const generated = new Set<string>();

      const resolveInternal = (specifier: string, importer: string) =>
        build.resolve(specifier, {
          importer,
          resolveDir: path.dirname(importer),
          kind: "import-statement",
          pluginData: { [internal]: true },
        });

      build.onResolve({ filter: /.*/ }, async (args) => {
        if (args.pluginData?.[internal]) return;
        if (args.path === readSpecifier) {
          const result = await build.resolve("@notation/resource/outputs", {
            kind: "import-statement",
            resolveDir: ownDir,
            pluginData: { [internal]: true },
          });
          if (result.errors.length > 0) return { errors: result.errors };
          return { path: result.path, external: result.external };
        }
        const type = args.with?.type;
        if (type === "runtime") {
          return {
            errors: [
              {
                text: `with { type: "runtime" } is only valid in infra modules, and ${toProjectRoot(args.importer)} is runtime code. Import ${args.path} without an attribute.`,
              },
            ],
          };
        }
        if (type === undefined) {
          if (isInfraPackage(args.path) && isLocalImporter(args.importer)) {
            return {
              errors: [
                {
                  text: `${toProjectRoot(args.importer)} imports ${args.path} without { type: "infra" }, so the bundle of runtime code would include infra. Import infra from runtime code with { type: "infra" }, and don't import modules that declare infra without it.`,
                },
              ],
            };
          }
          return;
        }
        if (type !== "infra") return;
        const target = await resolveInternal(args.path, args.importer);
        if (target.errors.length > 0) return { errors: target.errors };
        if (!isPackage(target)) {
          return {
            errors: [
              {
                text: `${toProjectRoot(args.importer)} imports ${args.path}, an infra module, in a way that the compiler can't rewrite. Import its bindings with import { ... } or import * as, and read them in runtime code.`,
              },
            ],
          };
        }
        const result = await resolveInternal(`${args.path}.fn`, args.importer);
        if (result.errors.length > 0) return { errors: result.errors };
        return {
          path: result.path,
          external: result.external,
          namespace: result.namespace,
          sideEffects: result.sideEffects,
        };
      });

      build.onLoad(
        { filter: /\.[cm]?[jt]sx?$/, namespace: "file" },
        async (args) => {
          if (args.path.split(path.sep).includes("node_modules")) return;
          const source = await getFile(args.path);
          if (!infraAttribute.test(source)) return;
          const providers = new Set<string>();
          const infraModules = new Map<string, string>();
          for (const decl of parseModule(args.path, source).imports) {
            if (decl.attribute !== "infra") continue;
            const target = await resolveInternal(decl.source, args.path);
            if (target.errors.length > 0) continue;
            if (isPackage(target)) providers.add(decl.source);
            else infraModules.set(decl.source, moduleKey(target.path));
          }
          const result = rewriteRuntimeModule(args.path, source, {
            providers,
            infraModules,
            readSpecifier,
          });
          if (result.errors.length > 0) return { errors: result.errors };
          for (const read of result.reads) generated.add(read);
          return { contents: result.code, loader: loaderFor(args.path) };
        },
      );

      build.onEnd(async (result) => {
        if (!opts.onReads || result.errors.length > 0) return;
        const cwd = build.initialOptions.absWorkingDir ?? process.cwd();
        const outputs = result.outputFiles
          ? result.outputFiles.map((file) => ({
              path: file.path,
              text: async () => file.text,
            }))
          : Object.keys(result.metafile?.outputs ?? {}).map((output) => {
              const file = path.resolve(cwd, output);
              return { path: file, text: () => readFile(file, "utf8") };
            });
        const reads: Record<string, string[]> = {};
        for (const output of outputs) {
          if (/\.(map|css)$/.test(output.path)) continue;
          reads[output.path] = findReads(await output.text()).filter((key) =>
            generated.has(key),
          );
        }
        opts.onReads(reads);
      });
    },
  };
}

// Matches the pure `read` calls that the rewrite makes, as esbuild prints
// them. esbuild may rename `read`, so any callee name matches.
const readCall =
  /\/\* @__PURE__ \*\/ [\w$]+\(("(?:[^"\\]|\\.)*"), (\[(?:[^\]"]|"(?:[^"\\]|\\.)*")*\])\)/g;

/** The output keys of the reads in a bundle that the rewrite made. */
export function findReads(bundle: string): string[] {
  const reads = new Set<string>();
  for (const match of bundle.matchAll(readCall)) {
    try {
      const binding = JSON.parse(match[1]!);
      const path = JSON.parse(match[2]!);
      if (typeof binding !== "string" || !Array.isArray(path)) continue;
      reads.add([binding, ...path].join("."));
    } catch {
      continue;
    }
  }
  return [...reads].sort();
}

// The directory of this module, so that `read` resolves from this package's
// dependencies, not the project's.
const ownDir = path.dirname(fileURLToPath(import.meta.url));

// Packages, or parts of them, that only infra uses. A provider's runtime half
// ends in `.fn`.
function isInfraPackage(specifier: string): boolean {
  if (/^@notation\/(aws\.iac\/shared|resource\/outputs)$/.test(specifier)) {
    return false;
  }
  if (/^@notation\/(resource|aws\.iac|std\.iac|core)(\/|$)/.test(specifier)) {
    return true;
  }
  return (
    /^@notation\/aws\/(?!testing$).+/.test(specifier) &&
    !specifier.endsWith(".fn")
  );
}

function isLocalImporter(importer: string): boolean {
  return (
    importer !== "" && isLocalModule({ path: importer, namespace: "file" })
  );
}

function isPackage(result: { external?: boolean; path: string }) {
  return !isLocalModule(result);
}

function loaderFor(file: string): Loader {
  if (/\.[cm]?tsx$/.test(file)) return "tsx";
  if (/\.[cm]?jsx$/.test(file)) return "jsx";
  if (/\.[cm]?js$/.test(file)) return "js";
  return "ts";
}
