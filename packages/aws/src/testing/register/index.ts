import * as nodeModule from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  infraModuleSource,
  isProvider,
  resolveLocal,
} from "src/testing/served";

type Attributes = Record<string, string>;
type ResolveContext = {
  conditions: string[];
  importAttributes: Attributes;
  parentURL?: string;
};
type ResolveResult = {
  url: string;
  format?: string | null;
  importAttributes?: Attributes;
  shortCircuit?: boolean;
};
type NextResolve = (
  specifier: string,
  context?: Partial<ResolveContext>,
) => ResolveResult;
type LoadResult = {
  format: string;
  source?: string | ArrayBuffer | Uint8Array;
  shortCircuit?: boolean;
};
type NextLoad = (url: string, context?: object) => LoadResult;

const infraQuery = "notation-infra";
const bindingModule = new URL("../index.js", import.meta.url).href;

function resolveFile(
  specifier: string,
  context: ResolveContext,
  next: NextResolve,
): ResolveResult {
  try {
    return next(specifier, context);
  } catch (error: any) {
    const parent = context.parentURL;
    const notFound =
      error?.code === "ERR_MODULE_NOT_FOUND" ||
      error?.code === "ERR_UNSUPPORTED_DIR_IMPORT";
    if (!notFound || !parent?.startsWith("file:")) throw error;
    const file = resolveLocal(specifier, fileURLToPath(parent));
    if (!file) throw error;
    return next(pathToFileURL(file).href, context);
  }
}

/**
 * Resolves the imports of a test as Notation's compiler does for a function's
 * bundle:
 *
 * 1. The `type` attribute is removed before Node resolves the import. Node
 *    recurses forever on a cycle of TypeScript imports with attributes.
 * 2. A `type: "infra"` import of a provider, such as `@notation/aws/lambda`,
 *    resolves to its runtime half, `@notation/aws/lambda.fn`.
 * 3. A `type: "infra"` import of an infra module resolves to a module that
 *    serves the values set with `setOutputs`. The infra module never runs.
 * 4. A project file imported without an extension resolves to its `.ts` file.
 */
function resolve(
  specifier: string,
  context: ResolveContext,
  next: NextResolve,
): ResolveResult {
  const { type, ...attributes } = context.importAttributes ?? {};
  if (type !== "infra" && type !== "runtime") {
    return resolveFile(specifier, context, next);
  }
  const plain = { ...context, importAttributes: attributes };
  const target = resolveFile(specifier, plain, next);
  if (type === "runtime" || !context.parentURL?.startsWith("file:")) {
    return { ...target, importAttributes: attributes };
  }
  const importer = fileURLToPath(context.parentURL);
  const file = target.url.startsWith("file:") ? fileURLToPath(target.url) : "";
  if (file && isProvider(specifier, file, importer)) {
    let half: ResolveResult;
    try {
      half = resolveFile(`${specifier}.fn`, plain, next);
    } catch (error) {
      throw new Error(
        `${specifier} is imported with { type: "infra" }, but its runtime half, ${specifier}.fn, can't be resolved.`,
        { cause: error },
      );
    }
    return { ...half, importAttributes: attributes };
  }
  const url = new URL(target.url);
  url.searchParams.set(infraQuery, "");
  return {
    url: url.href,
    format: "module",
    importAttributes: attributes,
    shortCircuit: true,
  };
}

function load(url: string, context: object, next: NextLoad): LoadResult {
  if (url.startsWith("file:") && new URL(url).searchParams.has(infraQuery)) {
    return {
      format: "module",
      source: infraModuleSource(fileURLToPath(url), bindingModule),
      shortCircuit: true,
    };
  }
  return next(url, context);
}

const registerHooks = (nodeModule as any).registerHooks as
  | ((hooks: { resolve: typeof resolve; load: typeof load }) => void)
  | undefined;

if (!registerHooks) {
  throw new Error(
    `@notation/aws/testing/register needs module.registerHooks(), which Node ${process.version} doesn't have. Use Node 22.15 or later.`,
  );
}

registerHooks({ resolve, load });
