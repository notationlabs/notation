import fs from "node:fs";
import path from "node:path";
import { ResolverFactory } from "rolldown/experimental";
import {
  isFunction,
  leadingJsDoc,
  parseModule,
  unwrap,
  type Node,
  type ParsedModule,
} from "./ast";
import { isPlatformName, platformNames, type PlatformName } from "./platforms";

/**
 * Marks a function that declares a function resource, such as a Lambda.
 * Written `@declaration shared: id, event, env; keys: env; entry: handler`.
 */
export type DeclarationMark = {
  kind: "declaration";
  /** Options that the infra build and the runtime build both keep. */
  shared: string[];
  /**
   * Options that only run in the function. The infra build replaces each one
   * with a function that throws.
   */
  runtime: string[];
  /**
   * Kept options whose value is a function that returns an object literal.
   * The runtime build keeps the keys and removes the values.
   */
  keys: string[];
  /** The export of the module that the platform calls, such as `handler`. */
  entry?: string;
  /** The platform that runs the function. Defaults to `node`. */
  platform?: PlatformName;
};

/**
 * Marks a function that declares a resource. Written `@resource`, or
 * `@resource runtime: schema` when a declaration's kept options read options
 * of the resource in the function. The first argument must then be an object
 * literal, and each of those options an import from a module that the
 * function can load. `@resource runtime:` with no options means that the
 * resource becomes `{}` in the function. A bare `@resource` has no
 * `runtime`, and the resource can't be read in the function.
 */
export type ResourceMark = { kind: "resource"; runtime?: string[] };

export type Mark = DeclarationMark | ResourceMark;

type ExportTarget = { local: string } | { source: string; imported: string };

/** An import binding. `imported` is `default` or `*` for those forms. */
export type ImportBinding = {
  source: string;
  imported: string;
  statement: Node;
  specifier: Node;
};

/** What the marks resolver needs to know about one module. */
export type ModuleTable = {
  module: ParsedModule;
  /** Marked functions declared in the module, by local name. */
  marks: Map<string, Mark>;
  /** Value imports, by local name. */
  imports: Map<string, ImportBinding>;
  exports: Map<string, ExportTarget>;
  /** The sources of `export * from` statements. */
  stars: string[];
};

const tags = ["declaration", "resource"] as const;

/** Reads the mark in a JSDoc comment, if it has one. */
export function parseMark(jsDoc: string, where: string): Mark | undefined {
  const text = jsDoc
    .split("\n")
    .map((line) => line.replace(/^\s*\*?\s?/, ""))
    .join("\n");
  for (const tag of tags) {
    const match = new RegExp(`(?:^|\\s)@${tag}\\b([^\\n@]*)`).exec(text);
    if (!match) continue;
    const body = match[1]!.trim();
    if (tag === "resource") {
      const runtime = /^runtime:(.*)$/.exec(body);
      if (body && !runtime) {
        throw new Error(
          `${where}: unknown clause "${body}" in the @resource mark. Use runtime.`,
        );
      }
      return runtime
        ? { kind: "resource", runtime: list(runtime[1]!) }
        : { kind: "resource" };
    }
    const mark: DeclarationMark = {
      kind: "declaration",
      shared: [],
      runtime: [],
      keys: [],
    };
    for (const clause of body
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)) {
      const [name, value = ""] = clause.split(":").map((part) => part.trim());
      if (name === "shared" || name === "runtime" || name === "keys") {
        mark[name] = list(value);
      } else if (name === "entry") {
        if (!value) {
          throw new Error(
            `${where}: the entry clause of the @declaration mark has no export name. Write entry: handler, or leave the clause out for a declaration with no runtime bundle.`,
          );
        }
        mark.entry = value;
      } else if (name === "platform") {
        if (!isPlatformName(value)) {
          throw new Error(
            `${where}: unknown platform "${value}" in the @declaration mark. Use ${platformNames.join(" or ")}.`,
          );
        }
        mark.platform = value;
      } else {
        throw new Error(
          `${where}: unknown clause "${name}" in the @declaration mark. Use shared, runtime, keys, entry or platform.`,
        );
      }
    }
    return mark;
  }
  return undefined;
}

const list = (text: string) =>
  text
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

const nameOf = (node: Node): string =>
  node.type === "Identifier" ? node.name : String(node.value);

function markOfDeclaration(
  module: ParsedModule,
  node: Node,
  commentStart: number,
  marks: Map<string, Mark>,
) {
  const where = `${module.file}`;
  if (node.type === "FunctionDeclaration" && node.id) {
    const jsDoc = leadingJsDoc(module, commentStart);
    const mark = jsDoc && parseMark(jsDoc, where);
    if (mark) marks.set(node.id.name, mark);
  }
  if (node.type === "VariableDeclaration" && node.declarations.length === 1) {
    const [declarator] = node.declarations;
    const init = declarator.init && unwrap(declarator.init);
    if (declarator.id.type !== "Identifier" || !init || !isFunction(init))
      return;
    const jsDoc = leadingJsDoc(module, commentStart);
    const mark = jsDoc && parseMark(jsDoc, where);
    if (mark) marks.set(declarator.id.name, mark);
  }
}

function declaredNames(node: Node): string[] {
  if (node.type === "VariableDeclaration") {
    return node.declarations.flatMap((d: Node) =>
      d.id.type === "Identifier" ? [d.id.name] : [],
    );
  }
  return node.id ? [node.id.name] : [];
}

/** Reads the imports, exports and marks of a parsed module. */
export function readModuleTable(module: ParsedModule): ModuleTable {
  const table: ModuleTable = {
    module,
    marks: new Map(),
    imports: new Map(),
    exports: new Map(),
    stars: [],
  };
  for (const statement of module.body) {
    switch (statement.type) {
      case "ImportDeclaration": {
        if (statement.importKind === "type") break;
        for (const specifier of statement.specifiers) {
          if (specifier.importKind === "type") continue;
          const imported =
            specifier.type === "ImportDefaultSpecifier"
              ? "default"
              : specifier.type === "ImportNamespaceSpecifier"
                ? "*"
                : nameOf(specifier.imported);
          table.imports.set(specifier.local.name, {
            source: statement.source.value,
            imported,
            statement,
            specifier,
          });
        }
        break;
      }
      case "FunctionDeclaration":
      case "VariableDeclaration":
        markOfDeclaration(module, statement, statement.start, table.marks);
        break;
      case "ExportNamedDeclaration": {
        if (statement.exportKind === "type") break;
        if (statement.declaration) {
          markOfDeclaration(
            module,
            statement.declaration,
            statement.start,
            table.marks,
          );
          for (const name of declaredNames(statement.declaration)) {
            table.exports.set(name, { local: name });
          }
          break;
        }
        for (const specifier of statement.specifiers) {
          if (specifier.exportKind === "type") continue;
          const exported = nameOf(specifier.exported);
          const local = nameOf(specifier.local);
          table.exports.set(
            exported,
            statement.source
              ? { source: statement.source.value, imported: local }
              : { local },
          );
        }
        break;
      }
      case "ExportDefaultDeclaration": {
        const declaration = statement.declaration;
        if (declaration.type === "FunctionDeclaration") {
          if (declaration.id) {
            markOfDeclaration(
              module,
              declaration,
              statement.start,
              table.marks,
            );
            table.exports.set("default", { local: declaration.id.name });
          }
        } else if (declaration.type === "Identifier") {
          table.exports.set("default", { local: declaration.name });
        } else {
          table.exports.set("default", { local: "*default*" });
        }
        break;
      }
      case "ExportAllDeclaration": {
        if (statement.exportKind === "type") break;
        if (statement.exported) {
          table.exports.set(nameOf(statement.exported), {
            source: statement.source.value,
            imported: "*",
          });
        } else {
          table.stars.push(statement.source.value);
        }
        break;
      }
    }
  }
  return table;
}

export type Resolve = (
  specifier: string,
  importer: string,
) => string | undefined;

const extensions = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".mjs",
  ".cjs",
  ".jsx",
  ".json",
];

/**
 * A resolver for reading marks. It uses the default export conditions, and
 * the `paths` of the importer's nearest tsconfig.
 */
export function createResolve(): Resolve {
  // ResolverFactory ignores `tsconfig: "auto"`, so each tsconfig gets its own
  // resolver.
  const resolvers = new Map<string | undefined, ResolverFactory>();
  const tsconfigs = new Map<string, string | undefined>();
  const resolverFor = (dir: string) => {
    let configFile = tsconfigs.get(dir);
    if (!tsconfigs.has(dir)) {
      configFile = nearestTsconfig(dir);
      tsconfigs.set(dir, configFile);
    }
    let resolver = resolvers.get(configFile);
    if (!resolver) {
      resolver = new ResolverFactory({
        tsconfig: configFile ? { configFile } : undefined,
        conditionNames: ["node", "import", "default"],
        extensions,
        extensionAlias: {
          ".js": [".ts", ".tsx", ".js"],
          ".mjs": [".mts", ".mjs"],
        },
      });
      resolvers.set(configFile, resolver);
    }
    return resolver;
  };
  return (specifier, importer) => {
    if (specifier.startsWith("node:")) return undefined;
    const dir = path.dirname(importer);
    const result = resolverFor(dir).sync(dir, specifier);
    return result.path ?? undefined;
  };
}

function nearestTsconfig(dir: string): string | undefined {
  for (; ; dir = path.dirname(dir)) {
    if (dir.split(path.sep).includes("node_modules")) return undefined;
    const file = path.join(dir, "tsconfig.json");
    if (fs.existsSync(file)) return file;
    if (dir === path.dirname(dir)) return undefined;
  }
}

/**
 * Finds the marks of the functions that modules import. Follows
 * `export { x } from`, `export * from` and `export { x }` of an import, to the
 * module that declares the function. Each module is parsed once, until it is
 * invalidated.
 */
export class Marks {
  #tables = new Map<string, ModuleTable | null>();
  #resolve: Resolve;
  #readFile: (file: string) => string;

  constructor(
    opts: { resolve?: Resolve; readFile?: (file: string) => string } = {},
  ) {
    this.#resolve = opts.resolve ?? createResolve();
    this.#readFile = opts.readFile ?? ((file) => fs.readFileSync(file, "utf8"));
  }

  resolve(specifier: string, importer: string): string | undefined {
    return this.#resolve(specifier, importer);
  }

  /** The table of a module, or `null` for a file that isn't JS or TS. */
  table(file: string): ModuleTable | null {
    let table = this.#tables.get(file);
    if (table === undefined) {
      table = /\.[cm]?[jt]sx?$/.test(file)
        ? readModuleTable(parseModule(file, this.#readFile(file)))
        : null;
      this.#tables.set(file, table);
    }
    return table;
  }

  /** Uses `source` as the contents of `file`, as a plugin's transform sees it. */
  setSource(file: string, source: string): ModuleTable {
    const table = readModuleTable(parseModule(file, source));
    this.#tables.set(file, table);
    return table;
  }

  invalidate(file: string) {
    this.#tables.delete(file);
  }

  /** The mark of an export of a module. */
  exportMark(
    file: string,
    name: string,
    seen: Set<string> = new Set(),
  ): Mark | undefined {
    const key = `${file}#${name}`;
    if (seen.has(key)) return undefined;
    seen.add(key);
    const table = this.table(file);
    if (!table) return undefined;
    const target = table.exports.get(name);
    if (target && "local" in target) {
      const mark = table.marks.get(target.local);
      if (mark) return mark;
      const binding = table.imports.get(target.local);
      return binding && this.importMark(file, binding, seen);
    }
    if (target) {
      if (target.imported === "*") return undefined;
      const resolved = this.resolve(target.source, file);
      return resolved
        ? this.exportMark(resolved, target.imported, seen)
        : undefined;
    }
    if (name === "default") return undefined;
    for (const source of table.stars) {
      const resolved = this.resolve(source, file);
      const mark = resolved ? this.exportMark(resolved, name, seen) : undefined;
      if (mark) return mark;
    }
    return undefined;
  }

  /**
   * Whether a module exports `name`, directly or through `export * from`.
   * A star source that doesn't resolve to a JS or TS file counts as
   * exporting the name, so that a resolver that differs from the bundler's
   * doesn't cause a false error. The bundler reports a name that is missing.
   */
  hasExport(
    file: string,
    name: string,
    seen: Set<string> = new Set(),
  ): boolean {
    if (seen.has(file)) return false;
    seen.add(file);
    const table = this.table(file);
    if (!table) return true;
    if (table.exports.has(name)) return true;
    if (name === "default") return false;
    return table.stars.some((source) => {
      const resolved = this.resolve(source, file);
      return !resolved || this.hasExport(resolved, name, seen);
    });
  }

  /** The mark of an import binding, or of `member` of a namespace import. */
  importMark(
    importer: string,
    binding: Pick<ImportBinding, "source" | "imported">,
    seen: Set<string> = new Set(),
    member?: string,
  ): Mark | undefined {
    const name = binding.imported === "*" ? member : binding.imported;
    if (name === undefined) return undefined;
    const resolved = this.resolve(binding.source, importer);
    return resolved ? this.exportMark(resolved, name, seen) : undefined;
  }
}
