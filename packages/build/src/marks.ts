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

/**
 * Marks a function that declares a function resource, such as a Lambda.
 * Written `@declaration shared: event, env; keys: env; entry: handler`.
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
};

/**
 * Marks a function that builds part of a declaration's options, such as
 * `sqs(schema)`. Written `@runtime schema`, with the names of the parameters
 * that the runtime build keeps.
 */
export type RuntimeMark = { kind: "runtime"; positions: number[] };

/** Marks a function that declares a resource. Written `@resource`. */
export type ResourceMark = { kind: "resource" };

export type Mark = DeclarationMark | RuntimeMark | ResourceMark;

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

const tags = ["declaration", "runtime", "resource"] as const;

/**
 * Reads the mark in a JSDoc comment, if it has one.
 * @param params The parameter names of the marked function.
 */
export function parseMark(
  jsDoc: string,
  params: string[],
  where: string,
): Mark | undefined {
  const text = jsDoc
    .split("\n")
    .map((line) => line.replace(/^\s*\*?\s?/, ""))
    .join("\n");
  for (const tag of tags) {
    const match = new RegExp(`(?:^|\\s)@${tag}\\b([^\\n@]*)`).exec(text);
    if (!match) continue;
    const body = match[1]!.trim();
    if (tag === "resource") return { kind: "resource" };
    if (tag === "runtime") {
      const names = list(body);
      const positions = names.map((name) => {
        const position = params.indexOf(name);
        if (position === -1) {
          throw new Error(
            `${where}: the @runtime mark names the parameter "${name}", which the function does not have`,
          );
        }
        return position;
      });
      return { kind: "runtime", positions };
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
        mark.entry = value;
      } else {
        throw new Error(
          `${where}: unknown clause "${name}" in the @declaration mark. Use shared, runtime, keys or entry.`,
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

function paramNames(fn: Node): string[] {
  return fn.params.map((param: Node) => {
    const target = param.type === "AssignmentPattern" ? param.left : param;
    return target.type === "Identifier" ? target.name : "";
  });
}

function markOfDeclaration(
  module: ParsedModule,
  node: Node,
  commentStart: number,
  marks: Map<string, Mark>,
) {
  const where = `${module.file}`;
  if (node.type === "FunctionDeclaration" && node.id) {
    const jsDoc = leadingJsDoc(module, commentStart);
    const mark = jsDoc && parseMark(jsDoc, paramNames(node), where);
    if (mark) marks.set(node.id.name, mark);
  }
  if (node.type === "VariableDeclaration" && node.declarations.length === 1) {
    const [declarator] = node.declarations;
    const init = declarator.init && unwrap(declarator.init);
    if (declarator.id.type !== "Identifier" || !init || !isFunction(init))
      return;
    const jsDoc = leadingJsDoc(module, commentStart);
    const mark = jsDoc && parseMark(jsDoc, paramNames(init), where);
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
 * the nearest tsconfig's `paths`.
 */
export function createResolve(): Resolve {
  const resolver = new ResolverFactory({
    tsconfig: "auto",
    conditionNames: ["node", "import", "default"],
    extensions,
    extensionAlias: { ".js": [".ts", ".tsx", ".js"], ".mjs": [".mts", ".mjs"] },
  });
  return (specifier, importer) => {
    if (specifier.startsWith("node:")) return undefined;
    const result = resolver.sync(path.dirname(importer), specifier);
    return result.path ?? undefined;
  };
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
