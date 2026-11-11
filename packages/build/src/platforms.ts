import { builtinModules } from "node:module";
import type { InputOptions, Plugin } from "rolldown";
import type { ModuleAnalysis } from "./analyze";
import { location, unwrap, type Node } from "./ast";

/** Where a deployed function runs: Node for a Lambda, workerd for a Worker. */
export type Platform = {
  /** Called for each build, so that `NODE_ENV` is read at build time. */
  build: () => InputOptions;
  /**
   * Whether the function's bundle exports every value that the module
   * exports by name, not only the handler. True for workerd, which finds a
   * Durable Object class by its export name.
   */
  reexportsModule: boolean;
  /** Fails if the platform can't start a module with the exports `names`. */
  checkExports?: (analysis: ModuleAnalysis, names: string[]) => void;
  /**
   * Modules that only this platform provides, such as `cloudflare:` modules.
   * The infra build removes them and the code that uses them, or fails.
   */
  provided?: {
    modules: RegExp;
    /** Used in errors: "only available in a Worker". */
    availableIn: string;
  };
};

const node: Platform = {
  build: () => ({
    platform: "node",
    resolve: {
      conditionNames: ["notation-runtime", "node", "import", "default"],
    },
  }),
  reexportsModule: false,
};

// Resolves a Node built-in to its `node:` module, which workerd provides
// under nodejs_compat, even if a package has the same name. workerd has no
// `require`, so a `require()` of a built-in gets a module that imports it.
const requiredBuiltin = "\0notation-required-builtin:";
const nodeBuiltinsPlugin: Plugin = {
  name: "notation-workerd-builtins",
  resolveId(source, _importer, options) {
    if (!source.startsWith("node:") && !builtinModules.includes(source)) {
      return null;
    }
    const name = source.replace(/^node:/, "");
    return options.kind === "require-call"
      ? `${requiredBuiltin}${name}`
      : { id: `node:${name}`, external: true };
  },
  load(id) {
    if (!id.startsWith(requiredBuiltin)) return null;
    const name = id.slice(requiredBuiltin.length);
    return `import builtin from "node:${name}";\nmodule.exports = builtin;\n`;
  },
};

// workerd only starts a module whose exports are functions, classes or
// plain objects. This catches the cases that are visible in the source.
function checkExports(analysis: ModuleAnalysis, names: string[]) {
  const { module } = analysis.table;
  const fail = (node: Node, name: string, value: string) => {
    throw new Error(
      `${module.file}:${location(module.source, node.start)}: the module exports ${name}, whose value is ${value}. The runtime bundle re-exports the module's exports, and workerd doesn't start a module that exports a value other than a function, a class or an object. Move ${name} to another module, or don't export it.`,
    );
  };
  const declarators = new Map<string, Node>();
  for (const statement of module.body) {
    const node =
      statement.type === "ExportNamedDeclaration"
        ? statement.declaration
        : statement;
    // Only `const` is checked, because a `let` or `var` can be assigned an
    // object later.
    if (node?.type !== "VariableDeclaration" || node.kind !== "const") continue;
    for (const declarator of node.declarations) {
      if (declarator.id.type === "Identifier") {
        declarators.set(declarator.id.name, declarator);
      }
    }
  }
  for (const name of names) {
    const target = analysis.table.exports.get(name)!;
    if ("source" in target) {
      if (target.imported !== "*") continue;
      const statement = module.body.find(
        (node: Node) =>
          node.type === "ExportAllDeclaration" &&
          node.exported &&
          (node.exported.name ?? node.exported.value) === name,
      );
      fail(statement!, name, "a module namespace object");
      continue;
    }
    const declarator = declarators.get(target.local);
    if (!declarator) continue;
    if (declarator.init && isPrimitive(declarator.init)) {
      fail(declarator, name, "a primitive, not an object");
    }
  }
}

function isPrimitive(expression: Node): boolean {
  const node = unwrap(expression);
  switch (node.type) {
    case "Literal":
      return !node.regex;
    case "TemplateLiteral":
    case "UnaryExpression":
    case "BinaryExpression":
      return true;
    case "Identifier":
      return node.name === "undefined";
    default:
      return false;
  }
}

const cloudflareModules = /^cloudflare:/;

// The conditions and the NODE_ENV defines match wrangler's.
const workerd: Platform = {
  build: () => {
    // wrangler also defaults to production on deploy.
    const nodeEnv = JSON.stringify(process.env.NODE_ENV || "production");
    return {
      platform: "neutral",
      resolve: {
        conditionNames: [
          "notation-runtime",
          "workerd",
          "worker",
          "browser",
          "import",
          "default",
        ],
        mainFields: ["browser", "module", "main"],
      },
      external: [cloudflareModules],
      transform: {
        define: {
          "process.env.NODE_ENV": nodeEnv,
          "global.process.env.NODE_ENV": nodeEnv,
          "globalThis.process.env.NODE_ENV": nodeEnv,
        },
      },
      plugins: [nodeBuiltinsPlugin],
    };
  },
  reexportsModule: true,
  checkExports,
  provided: { modules: cloudflareModules, availableIn: "a Worker" },
};

const platforms = { node, workerd };

export type PlatformName = keyof typeof platforms;

export const platformNames = Object.keys(platforms) as PlatformName[];

export const isPlatformName = (name: string): name is PlatformName =>
  Object.hasOwn(platforms, name);

/** The platform that alone provides the module `source`, if any. */
export const providerOfModule = (source: string): PlatformName | undefined =>
  platformNames.find((name) => platforms[name].provided?.modules.test(source));

/**
 * Returns text for an error, such as "cloudflare:workers, which is only
 * available in a Worker".
 */
export function describeProvided(source: string): string {
  const platform = providerOfModule(source);
  const where = platform && platforms[platform].provided?.availableIn;
  return where ? `${source}, which is only available in ${where}` : source;
}

/** Defaults to Node. */
export const platformOf = (name: PlatformName = "node"): Platform =>
  platforms[name];
