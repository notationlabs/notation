import { builtinModules } from "node:module";
import type { InputOptions, Plugin } from "rolldown";
import type { ModuleAnalysis } from "./analyze";
import { location, unwrap, type Node } from "./ast";

/** A platform that runs the runtime bundle of a declaration module. */
export type Platform = {
  /**
   * The Rolldown input options of the runtime bundle, such as `platform`,
   * `resolve` and `plugins`. Called for each build, so that options that
   * read the environment, such as `NODE_ENV`, read it as it is then.
   */
  build: () => InputOptions;
  /**
   * Whether the runtime entry also re-exports the module's other value
   * exports, besides the declaration's entry, for a platform that reads
   * named exports, such as Durable Object classes.
   */
  reexportsModule: boolean;
  /**
   * Fails for one of `names`, the other exports that the runtime entry
   * re-exports, whose value the platform doesn't start with.
   */
  checkExports?: (analysis: ModuleAnalysis, names: string[]) => void;
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

// workerd provides Node's built-in modules as `node:` modules, under the
// nodejs_compat flag. A bare name, such as `events`, is imported as its
// `node:` module, even when an installed package, such as a polyfill, has
// the same name. A name with a trailing slash, such as `events/`, is left
// to resolve as a package. workerd has no `require`, so a `require()` of a
// built-in, as in a CommonJS package, gets a module that imports it, as
// wrangler does.
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
// objects whose prototype chain ends in Object.prototype. This check covers
// the values that the build can see.
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
    // A `let` or `var` can be assigned an object later, so only a `const`
    // is checked.
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

// The conditions and the NODE_ENV defines are the ones that wrangler uses.
// workerd provides the `cloudflare:` and `node:` modules, so the bundle
// leaves them external.
const workerd: Platform = {
  build: () => {
    // Like wrangler on deploy, unless NODE_ENV is set.
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
      external: [/^cloudflare:/],
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
};

const platforms = { node, workerd };

export type PlatformName = keyof typeof platforms;

export const platformNames = Object.keys(platforms) as PlatformName[];

export const isPlatformName = (name: string): name is PlatformName =>
  Object.hasOwn(platforms, name);

/** The platform of a mark's `platform:` clause, or Node when it has none. */
export const platformOf = (name: PlatformName = "node"): Platform =>
  platforms[name];
