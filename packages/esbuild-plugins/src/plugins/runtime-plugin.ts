import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PartialMessage, Plugin } from "esbuild";
import { toProjectRoot } from "@notation/core";
import { parseModule } from "src/infra-phase/module-info";
import { moduleKey } from "src/runtime-modules";
import { rewriteRuntimeModule } from "src/runtime-bundle/rewrite";
import { isLocalModule } from "src/utils/is-local";
import { loaderFor } from "src/utils/script";
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
const readNamespace = "notation-read";
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
      build.initialOptions.metafile = true;
      // Every read that a rewrite made. A call in the output counts as a read
      // only if it is one of these.
      const generated = new Set<string>();
      // The error for each infra call that a rewrite replaced, by its ID. The
      // ID is in a bundle only if tree-shaking kept the call.
      const infraCalls = new Map<string, PartialMessage>();

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
          return { path: "read", namespace: readNamespace };
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
          for (const call of result.infraCalls) {
            infraCalls.set(call.id, call.error);
          }
          return { contents: result.code, loader: loaderFor(args.path) };
        },
      );

      // Wraps `read`, so that the metafile shows whether a bundle calls it.
      build.onLoad({ filter: /.*/, namespace: readNamespace }, () => ({
        contents: [
          `import { read as outputsRead } from "@notation/resource/outputs";`,
          `export function read(binding, path) { return outputsRead(binding, path); }`,
        ].join("\n"),
        loader: "js",
        resolveDir: ownDir,
      }));

      build.onEnd(async (result) => {
        if (result.errors.length > 0) return;
        if (!opts.onReads && infraCalls.size === 0) return;
        const cwd = build.initialOptions.absWorkingDir ?? process.cwd();
        const metas = Object.entries(result.metafile?.outputs ?? {})
          .map(([output, meta]) => ({ file: path.resolve(cwd, output), meta }))
          .filter(({ file }) => !/\.(map|css)$/.test(file));
        const outputs = result.outputFiles
          ? result.outputFiles
              .filter((file) => !/\.(map|css)$/.test(file.path))
              .map((file, _, all) => ({
                file: file.path,
                text: async () => file.text,
                // esbuild names an output without an outfile `<stdout>`, and
                // gives it another name in the metafile.
                meta:
                  metas.find((meta) => meta.file === file.path)?.meta ??
                  (all.length === 1 && metas.length === 1
                    ? metas[0]!.meta
                    : undefined),
              }))
          : metas.map(({ file, meta }) => ({
              file,
              text: () => readFile(file, "utf8"),
              meta,
            }));
        const reads: Record<string, string[]> = {};
        const errors: PartialMessage[] = [];
        for (const { file, text: readText, meta } of outputs) {
          const text = await readText();
          for (const [id, error] of infraCalls) {
            if (text.includes(JSON.stringify(id))) errors.push(error);
          }
          const found = findReads(text).filter((key) => generated.has(key));
          const callsRead = Object.entries(meta?.inputs ?? {}).some(
            ([input, { bytesInOutput }]) =>
              input.startsWith(`${readNamespace}:`) && bytesInOutput > 0,
          );
          if (callsRead && found.length === 0) {
            errors.push({
              text: `${toProjectRoot(file)} reads values from infra, but the compiler found none of its reads. This is a bug in the Notation compiler.`,
            });
          }
          reads[file] = found;
        }
        if (errors.length > 0) return { errors };
        opts.onReads?.(reads);
      });
    },
  };
}

const stringLiteral = String.raw`"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'`;
// Matches calls with the shape of the `read` calls that the rewrite makes,
// however esbuild prints them: any callee name, since esbuild may rename
// `read`, and any spacing. Callers keep only the reads that a rewrite made.
const readCall = new RegExp(
  String.raw`[\w$]+\s*\(\s*(${stringLiteral})\s*,\s*(\[\s*(?:(?:${stringLiteral})\s*(?:,\s*(?:${stringLiteral})\s*)*,?\s*)?\])\s*\)`,
  "g",
);
const stringInArray = new RegExp(stringLiteral, "g");

/** The output keys of the calls in a bundle that look like reads. */
export function findReads(bundle: string): string[] {
  const reads = new Set<string>();
  for (const match of bundle.matchAll(readCall)) {
    try {
      const binding = parseString(match[1]!);
      const path = [...match[2]!.matchAll(stringInArray)].map((item) =>
        parseString(item[0]),
      );
      reads.add([binding, ...path].join("."));
    } catch {
      continue;
    }
  }
  return [...reads].sort();
}

function parseString(literal: string): string {
  if (literal.startsWith('"')) return JSON.parse(literal);
  const body = literal.slice(1, -1).replace(/\\'/g, "'").replace(/"/g, '\\"');
  return JSON.parse(`"${body}"`);
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
