import path from "node:path";
import MagicString from "magic-string";
import { freeReferences, location, unwrap, type Node } from "./ast";
import type { Declaration, ModuleAnalysis } from "./analyze";
import type { Marks } from "./marks";

/** The name of the helper that records the module of a declaration. */
export const declaredInHelper = "__notation_declaredIn";

const unnamedHelper = "__notation_unnamed";

// The same key as `declaredIn` in @notation/resource, which reads the record.
// The helper is written into the module, so the user's project doesn't have
// to resolve a notation package from the module's directory.
const helper = `
function ${declaredInHelper}(value, path, binding, moduleExports) {
  if ((typeof value === "object" && value !== null) || typeof value === "function") {
    Object.defineProperty(value, Symbol.for("@notation/declaredIn"), { value: { path, binding, ...moduleExports } });
  }
  return value;
}
function ${unnamedHelper}(message) {
  return () => { throw new Error(message); };
}
`;

/** A declaration module, as the infra build records it. */
export type DeclarationModule = {
  /** The absolute path of the module. */
  path: string;
  /** The local name of the binding that holds the declaration. */
  binding: string;
  /**
   * The export that the platform calls, such as `handler`. A declaration
   * whose mark has no `entry`, such as a Durable Object namespace, has no
   * runtime bundle of its own.
   */
  entry?: string;
  /** Set for `workerd`. Absent means `node`. */
  platform?: "workerd";
  /**
   * The other exports that the runtime bundle re-exports, besides `entry`.
   * Only on `workerd`, which reads named exports such as Durable Object
   * classes. The declaration's binding is left out.
   */
  exports?: string[];
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
// that those statements use. References in `runtime:` options don't count,
// because the strip replaces those options. So a Durable Object class that
// `class: Counter` names, and the imports of the class, are removed.
function keptStatements(analysis: ModuleAnalysis) {
  const declaration = analysis.declaration!;
  const { module } = analysis.table;
  const owners = new Map<string, Node>();
  for (const statement of module.body) {
    for (const name of declaredBy(statement)) owners.set(name, statement);
  }

  const skip = new Set<Node>();
  const runtimeNames = new Map<string, string>();
  for (const option of declaration.mark.runtime) {
    const property = declaration.properties.get(option);
    if (!property) continue;
    skip.add(property);
    const name = moduleName(analysis, property);
    if (name) runtimeNames.set(name, option);
  }
  const kept = new Set<Node>([declaration.statement]);
  const usedImports = new Set<string>();
  const queue: Node[] = [declaration.statement];
  while (queue.length > 0) {
    const statement = queue.pop()!;
    const references =
      statement === declaration.statement
        ? freeReferences(statement, skip)
        : freeReferences(statement);
    for (const { node } of references) {
      const option = runtimeNames.get(node.name);
      if (option) {
        // Keeping the name would load the value that the option leaves out,
        // such as a class that imports cloudflare:workers.
        throw new Error(
          `${module.file}:${location(module.source, node.start)}: ${node.name} is the ${option} option of ${declaration.name}, which the infra build leaves out, so the declaration can't use ${node.name} anywhere else.`,
        );
      }
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
  for (const name of [declaredInHelper, unnamedHelper]) {
    if (
      analysis.table.marks.has(name) ||
      module.source.includes(`function ${name}(`)
    ) {
      throw new Error(
        `${module.file}: the name ${name} is reserved for the build.`,
      );
    }
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

  const exports =
    declaration.mark.platform === "workerd" && entry
      ? otherExports(analysis, entry)
      : undefined;
  if (exports) checkWorkerdExports(analysis, exports);
  const record = [
    path.relative(root, module.file).split(path.sep).join("/"),
    declaration.binding,
    ...(exports ? [{ exports, starExports: analysis.table.stars }] : []),
  ];
  replaceRuntimeOptions(s, analysis);
  s.prependLeft(declaration.call.start, `${declaredInHelper}(`);
  s.appendRight(
    declaration.call.end,
    `, ${record.map((arg) => JSON.stringify(arg)).join(", ")})`,
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
      ...(entry ? { entry } : {}),
      ...(exports ? { platform: "workerd" as const, exports } : {}),
    },
  };
}

/**
 * The exports that the runtime bundle of a declaration module re-exports:
 * the entry, and on `workerd` the module's other value exports. Empty when
 * the declaration has no entry.
 */
export function runtimeExports(analysis: ModuleAnalysis): string[] {
  const entry = analysis.declaration?.mark.entry;
  if (!entry) return [];
  return analysis.declaration!.mark.platform === "workerd"
    ? [entry, ...otherExports(analysis, entry)]
    : [entry];
}

// Names from `export * from` are missing, as the module's table doesn't
// hold them.
function otherExports(analysis: ModuleAnalysis, entry: string): string[] {
  const binding = analysis.declaration!.binding;
  const types = typeOnlyNames(analysis);
  return [...analysis.table.exports]
    .filter(
      ([name, target]) =>
        name !== entry &&
        !(
          "local" in target &&
          (target.local === binding || types.has(target.local))
        ),
    )
    .map(([name]) => name)
    .sort();
}

// workerd only starts a module whose exports are functions, classes or
// objects whose prototype chain ends in Object.prototype. This check covers
// the values that the build can see.
function checkWorkerdExports(analysis: ModuleAnalysis, exports: string[]) {
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
  for (const name of exports) {
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

/**
 * The local names of a module that only name a type: interfaces, type
 * aliases, `declare` statements, namespaces that hold only types, and type
 * imports. `export { Local }` of such a name has no value to re-export. A
 * name that also has a value, such as an interface merged with a class, is
 * left out.
 */
export function typeOnlyNames(analysis: ModuleAnalysis): Set<string> {
  const types = new Set<string>();
  const values = new Set<string>(analysis.table.imports.keys());
  for (const statement of analysis.table.module.body) {
    const node =
      statement.type === "ExportNamedDeclaration" && statement.declaration
        ? statement.declaration
        : statement;
    if (node.type === "ImportDeclaration") {
      for (const specifier of node.specifiers) {
        if (node.importKind === "type" || specifier.importKind === "type")
          types.add(specifier.local.name);
      }
    } else if (
      node.type === "TSInterfaceDeclaration" ||
      node.type === "TSTypeAliasDeclaration" ||
      (node.type === "TSModuleDeclaration" && holdsOnlyTypes(node))
    ) {
      types.add(node.id.name);
    } else {
      for (const name of declaredBy(node)) {
        (node.declare ? types : values).add(name);
      }
    }
  }
  for (const name of values) types.delete(name);
  return types;
}

function holdsOnlyTypes(namespace: Node): boolean {
  const body = namespace.body;
  if (!body) return true;
  if (body.type === "TSModuleDeclaration") return holdsOnlyTypes(body);
  return body.body.every((statement: Node) => {
    const node =
      statement.type === "ExportNamedDeclaration" && statement.declaration
        ? statement.declaration
        : statement;
    return node.type === "TSModuleDeclaration"
      ? holdsOnlyTypes(node)
      : isTypeOnly(statement);
  });
}

// The name that a `runtime:` option passes, such as `Counter` in
// `class: Counter`, if the module declares or imports it.
function moduleName(analysis: ModuleAnalysis, property: Node) {
  if (property.method) return undefined;
  const value = unwrap(property.value);
  if (value.type !== "Identifier") return undefined;
  const declared = analysis.table.module.body.some((statement: Node) =>
    declaredBy(statement).includes(value.name),
  );
  return declared || analysis.table.imports.has(value.name)
    ? (value.name as string)
    : undefined;
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

// An option whose value is a name that the module declares or imports, such
// as `class: Counter`, becomes a function with that name, so the infra build
// can read `config.class.name` without loading the class. The name is the
// local name at the call site. Any other value becomes a function whose
// name is "", so that a provider can reject an option that needs a name.
function replaceRuntimeOptions(s: MagicString, analysis: ModuleAnalysis) {
  const declaration = analysis.declaration!;
  const { module } = analysis.table;
  for (const option of declaration.mark.runtime) {
    const property = declaration.properties.get(option);
    if (!property) continue;
    const value = unwrap(property.value);
    if (value.type === "ClassExpression") {
      throw new Error(
        `${module.file}:${location(module.source, value.start)}: the ${option} option of ${declaration.name} is a class expression. Declare the class at the top level of the module, and pass its name.`,
      );
    }
    const message = JSON.stringify(
      `${option} only runs in the function, not in the infra build.`,
    );
    const name = moduleName(analysis, property);
    // A function returned from the helper has no name. Rolldown removes a
    // comma or `void` in front of an arrow function, and the function would
    // then take the option's key as its name.
    const thrower = name
      ? `function ${name}() { throw new Error(${message}); }`
      : `${unnamedHelper}(${message})`;
    if (property.shorthand || property.method) {
      const key = module.source.slice(property.key.start, property.key.end);
      s.overwrite(property.start, property.end, `${key}: ${thrower}`);
    } else {
      s.overwrite(property.value.start, property.value.end, thrower);
    }
  }
}
