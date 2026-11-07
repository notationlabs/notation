import path from "node:path";
import MagicString from "magic-string";
import { freeReferences, type Node } from "./ast";
import type { Declaration, ModuleAnalysis } from "./analyze";
import type { Marks } from "./marks";

/** The name of the helper that records the module of a declaration. */
export const declaredInHelper = "__notation_declaredIn";

// The same key as `declaredIn` in @notation/resource, which reads the record.
// The helper is written into the module, so the user's project doesn't have
// to resolve a notation package from the module's directory.
const helper = `
function ${declaredInHelper}(value, path, binding) {
  if ((typeof value === "object" && value !== null) || typeof value === "function") {
    Object.defineProperty(value, Symbol.for("@notation/declaredIn"), { value: { path, binding } });
  }
  return value;
}
`;

/** A declaration module, as the infra build records it. */
export type DeclarationModule = {
  /** The absolute path of the module. */
  path: string;
  /** The local name of the binding that holds the declaration. */
  binding: string;
  /** The export that the platform calls, such as `handler`. */
  entry: string;
};

const isTypeOnly = (statement: Node): boolean =>
  statement.type === "TSTypeAliasDeclaration" ||
  statement.type === "TSInterfaceDeclaration" ||
  (statement.type === "ImportDeclaration" && statement.importKind === "type") ||
  ((statement.type === "ExportNamedDeclaration" ||
    statement.type === "ExportAllDeclaration") &&
    statement.exportKind === "type") ||
  (statement.type === "ExportNamedDeclaration" &&
    statement.declaration &&
    isTypeOnly(statement.declaration)) ||
  statement.declare === true;

function declaredBy(statement: Node): string[] {
  const node =
    statement.type === "ExportNamedDeclaration"
      ? statement.declaration
      : statement;
  if (!node) return [];
  if (node.type === "VariableDeclaration") {
    return node.declarations.flatMap((declarator: Node) =>
      namesOf(declarator.id),
    );
  }
  if (
    node.type === "FunctionDeclaration" ||
    node.type === "ClassDeclaration" ||
    node.type === "TSEnumDeclaration" ||
    node.type === "TSModuleDeclaration"
  ) {
    return node.id?.type === "Identifier" ? [node.id.name] : [];
  }
  return [];
}

function namesOf(pattern: Node): string[] {
  const names: string[] = [];
  const visit = (node: Node | null) => {
    if (!node) return;
    if (node.type === "Identifier") names.push(node.name);
    else if (node.type === "ObjectPattern")
      node.properties.forEach((p: Node) =>
        visit(p.type === "RestElement" ? p.argument : p.value),
      );
    else if (node.type === "ArrayPattern") node.elements.forEach(visit);
    else if (node.type === "RestElement") visit(node.argument);
    else if (node.type === "AssignmentPattern") visit(node.left);
  };
  visit(pattern);
  return names;
}

// The statements that the infra copy of a declaration module keeps: the
// declaration and the top-level statements that it uses, and the imports
// that those statements use.
function keptStatements(analysis: ModuleAnalysis) {
  const { module } = analysis.table;
  const owners = new Map<string, Node>();
  for (const statement of module.body) {
    for (const name of declaredBy(statement)) owners.set(name, statement);
  }

  const kept = new Set<Node>([analysis.declaration!.statement]);
  const usedImports = new Set<string>();
  const queue: Node[] = [analysis.declaration!.statement];
  while (queue.length > 0) {
    const statement = queue.pop()!;
    for (const { node } of freeReferences(statement)) {
      const owner = owners.get(node.name);
      if (owner && !kept.has(owner)) {
        kept.add(owner);
        queue.push(owner);
      }
      if (analysis.table.imports.has(node.name)) usedImports.add(node.name);
    }
  }
  return { owners, kept, usedImports };
}

/**
 * The exports of a declaration module that its infra copy keeps, and the
 * local names of the imports that the copy keeps.
 */
export function infraInterface(analysis: ModuleAnalysis): {
  exports: Set<string>;
  imports: Set<string>;
} {
  const { owners, kept, usedImports } = keptStatements(analysis);
  const exports = new Set<string>();
  for (const [name, target] of analysis.table.exports) {
    if ("local" in target && keptName(target.local, owners, kept)) {
      exports.add(name);
    }
  }
  return { exports, imports: usedImports };
}

/**
 * The copy of a declaration module that the infra build runs. It keeps the
 * declaration and the top-level statements that the declaration uses, and
 * removes everything else, such as the handler, SDK clients and side-effect
 * imports. The declaration is wrapped in a call that records the module's
 * path and the binding's name against the declaration's value. Options that
 * only run in the function are replaced with a function that throws.
 *
 * The path is relative to `root`, the project root, so that the bundle is
 * the same on every machine.
 */
export function stripForInfra(
  analysis: ModuleAnalysis,
  marks: Marks,
  root: string,
): {
  code: string;
  map: ReturnType<MagicString["generateMap"]>;
  declaration: DeclarationModule;
} {
  const declaration = analysis.declaration!;
  const { module } = analysis.table;
  const entry = declaration.mark.entry;
  if (entry && !marks.hasExport(module.file, entry)) {
    throw new Error(
      `${module.file}: the module declares a function with ${declaration.name}, so it must export \`${entry}\`, the entry that the platform calls.`,
    );
  }
  if (
    analysis.table.marks.has(declaredInHelper) ||
    module.source.includes(`function ${declaredInHelper}(`)
  ) {
    throw new Error(
      `${module.file}: the name ${declaredInHelper} is reserved for the build.`,
    );
  }

  const { owners, kept, usedImports } = keptStatements(analysis);

  const s = new MagicString(module.source);
  for (const statement of module.body) {
    if (kept.has(statement) || isTypeOnly(statement)) continue;
    if (statement.type === "ImportDeclaration") {
      const replacement = keptImport(statement, usedImports, module.source);
      if (replacement === undefined) s.remove(statement.start, statement.end);
      else s.overwrite(statement.start, statement.end, replacement);
      continue;
    }
    if (
      statement.type === "ExportNamedDeclaration" &&
      !statement.declaration &&
      !statement.source
    ) {
      const specifiers = statement.specifiers.filter(
        (specifier: Node) =>
          specifier.exportKind === "type" ||
          keptName(specifier.local.name, owners, kept),
      );
      if (specifiers.length === 0) s.remove(statement.start, statement.end);
      else
        s.overwrite(
          statement.start,
          statement.end,
          `export { ${specifiers.map((sp: Node) => module.source.slice(sp.start, sp.end)).join(", ")} };`,
        );
      continue;
    }
    s.remove(statement.start, statement.end);
  }

  replaceRuntimeOptions(s, declaration);
  s.prependLeft(declaration.call.start, `${declaredInHelper}(`);
  s.appendRight(
    declaration.call.end,
    `, ${JSON.stringify(path.relative(root, module.file).split(path.sep).join("/"))}, ${JSON.stringify(declaration.binding)})`,
  );
  s.append(helper);

  return {
    code: s.toString(),
    map: s.generateMap({
      hires: true,
      source: module.file,
      includeContent: true,
    }),
    declaration: {
      path: module.file,
      binding: declaration.binding,
      entry: entry ?? "handler",
    },
  };
}

const keptName = (name: string, owners: Map<string, Node>, kept: Set<Node>) => {
  const owner = owners.get(name);
  return owner !== undefined && kept.has(owner);
};

// The import with only the value specifiers that kept code uses, or
// `undefined` when it has none.
function keptImport(
  statement: Node,
  used: Set<string>,
  source: string,
): string | undefined {
  const specifiers = statement.specifiers.filter(
    (specifier: Node) =>
      specifier.importKind !== "type" && used.has(specifier.local.name),
  );
  if (specifiers.length === 0) return undefined;
  const from = source.slice(statement.source.start, statement.source.end);
  const text = (node: Node) => source.slice(node.start, node.end);
  const defaults = specifiers
    .filter((sp: Node) => sp.type === "ImportDefaultSpecifier")
    .map(text);
  const namespace = specifiers
    .filter((sp: Node) => sp.type === "ImportNamespaceSpecifier")
    .map(text);
  const named = specifiers
    .filter((sp: Node) => sp.type === "ImportSpecifier")
    .map(text);
  const parts = [...defaults, ...namespace];
  if (named.length > 0) parts.push(`{ ${named.join(", ")} }`);
  // A namespace import can't share a statement with named imports.
  if (namespace.length > 0 && named.length > 0) {
    return [
      `import ${[...defaults, ...namespace].join(", ")} from ${from};`,
      `import { ${named.join(", ")} } from ${from};`,
    ].join("\n");
  }
  return `import ${parts.join(", ")} from ${from};`;
}

function replaceRuntimeOptions(s: MagicString, declaration: Declaration) {
  for (const option of declaration.mark.runtime) {
    const property = declaration.properties.get(option);
    if (!property) continue;
    const message = `${option} only runs in the function, not in the infra build.`;
    const thrower = `() => { throw new Error(${JSON.stringify(message)}); }`;
    if (property.shorthand) {
      s.overwrite(property.start, property.end, `${option}: ${thrower}`);
    } else {
      s.overwrite(property.value.start, property.value.end, thrower);
    }
  }
}
