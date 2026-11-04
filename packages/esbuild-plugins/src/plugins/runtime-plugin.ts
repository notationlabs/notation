import path from "node:path";
import ts from "typescript";
import type { Loader, Plugin } from "esbuild";
import { toProjectRoot } from "@notation/core";
import { chainRoot, parseModule } from "src/infra-phase/module-info";
import { isLocalModule } from "src/utils/is-local";
import { GetFile, fsGetFile, withFileCheck } from "src/utils/get-file";

type PluginOpts = {
  getFile?: GetFile;
};

const internal = Symbol.for("@notation/esbuild-plugins/runtime-internal");
const infraAttribute = /\btype\s*:\s*["']infra["']/;

/**
 * Bundles a function's runtime code. A `type: "infra"` import of a provider,
 * such as `@notation/aws/lambda`, becomes an import of the provider's runtime
 * half, `@notation/aws/lambda.fn`, and each call to one of its factories
 * loses its arguments, which only the infra phase reads. TypeScript imports that are
 * then unused are dropped, so infra that only the settings use is not
 * bundled.
 *
 * Reading an infra module's values from runtime code is not supported yet:
 * such an import fails the build.
 */
export function runtimePlugin(opts: PluginOpts = {}): Plugin {
  const getFile = withFileCheck(opts.getFile || fsGetFile);
  return {
    name: "notation-runtime",
    setup(build) {
      const resolveInternal = (specifier: string, importer: string) =>
        build.resolve(specifier, {
          importer,
          resolveDir: path.dirname(importer),
          kind: "import-statement",
          pluginData: { [internal]: true },
        });

      build.onResolve({ filter: /.*/ }, async (args) => {
        if (args.pluginData?.[internal]) return;
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
        if (type !== "infra") return;
        const target = await resolveInternal(args.path, args.importer);
        if (target.errors.length > 0) return { errors: target.errors };
        if (!isPackage(target)) {
          return {
            errors: [
              {
                text: `${toProjectRoot(args.importer)} reads ${args.path}, an infra module, from runtime code. Only lambda() settings can use infra values for now.`,
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
          for (const decl of parseModule(args.path, source).imports) {
            if (decl.attribute !== "infra") continue;
            const target = await resolveInternal(decl.source, args.path);
            if (target.errors.length === 0 && isPackage(target)) {
              providers.add(decl.source);
            }
          }
          return {
            contents: removeFactoryArguments(args.path, source, providers),
            loader: loaderFor(args.path),
          };
        },
      );
    },
  };
}

/**
 * Points each `type: "infra"` import of a provider, such as
 * `@notation/aws/lambda`, at the provider's runtime half, and removes the
 * arguments of each call to a binding it imports, such as `lambda({ ... })`.
 * @param providers The import specifiers that name providers.
 */
export function removeFactoryArguments(
  file: string,
  source: string,
  providers: Set<string>,
): string {
  const info = parseModule(file, source);
  const factories = new Set<string>();
  const edits: Array<[number, number, string]> = [];
  for (const decl of info.imports) {
    if (decl.attribute !== "infra" || !providers.has(decl.source)) {
      continue;
    }
    for (const binding of decl.bindings) factories.add(binding.local);
    const { moduleSpecifier, attributes } = decl.node;
    edits.push([
      moduleSpecifier.getStart(),
      attributes!.end,
      JSON.stringify(`${decl.source}.fn`),
    ]);
  }
  if (factories.size === 0) return source;

  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const chain = chainRoot(node.expression);
      if (chain && !chain.called && factories.has(chain.root)) {
        edits.push([node.arguments.pos, node.arguments.end, ""]);
        visit(node.expression);
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(info.sourceFile);

  let out = "";
  let cursor = 0;
  for (const [start, end, text] of edits.sort((a, b) => a[0] - b[0])) {
    out += source.slice(cursor, start) + text;
    cursor = end;
  }
  return out + source.slice(cursor);
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
