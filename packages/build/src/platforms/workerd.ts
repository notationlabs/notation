import { builtinModules } from "node:module";
import type { Plugin } from "rolldown";
import type { ModuleAnalysis } from "../analyze";
import { location, unwrap, type Node } from "../ast";
import type { Platform } from "./types";

// workerd provides Node's built-in modules as `node:` modules, under the
// nodejs_compat flag. A bare name, such as `events`, that no installed
// package provides is imported as its `node:` module. workerd has no
// `require`, so a `require()` of a built-in, as in a CommonJS package, gets
// a module that imports it, as wrangler does.
const requiredBuiltin = "\0notation-required-builtin:";
const nodeBuiltinsPlugin: Plugin = {
  name: "notation-workerd-builtins",
  async resolveId(source, importer, options) {
    const prefixed = source.startsWith("node:");
    if (!prefixed && !builtinModules.includes(source)) return null;
    const name = source.replace(/^node:/, "");
    if (!prefixed) {
      const resolved = await this.resolve(source, importer, options);
      if (resolved && !resolved.external) return resolved;
    }
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

// Like wrangler on deploy, unless NODE_ENV is set.
const nodeEnv = JSON.stringify(process.env.NODE_ENV || "production");

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
    if (node?.type !== "VariableDeclaration") continue;
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
    if (!declarator.init) fail(declarator, name, "undefined");
    else if (isPrimitive(declarator.init)) {
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
export const workerd: Platform = {
  build: {
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
  },
  reexports: "module",
  checkExports,
};
