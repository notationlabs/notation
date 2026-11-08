import {
  freeReferences,
  isFunction,
  location,
  unwrap,
  type Node,
  type Reference,
} from "./ast";
import type { DeclarationMark, Mark, Marks, ModuleTable } from "./marks";

/** A reference whose binding resolves to a marked function. */
export type MarkedReference = Reference & {
  mark: Mark;
  /** The call or `new` expression that calls the function, if any. */
  call?: Node;
  /** The name of the function, as written, such as `ns.$lambda`. */
  name: string;
};

/** A call to a declaration function, such as `$lambda({ ... })`. */
export type Declaration = {
  mark: DeclarationMark;
  name: string;
  /** The top-level statement that holds the declaration. */
  statement: Node;
  /** The local name of the binding that holds the declaration's value. */
  binding: string;
  call: Node;
  options: Node;
  /** The options' properties, by key. */
  properties: Map<string, Node>;
};

/** A resource function that a module imports or re-exports. */
export type ResourceImport = {
  /** The name of the function, as written, such as `queue` or `sqs.queue`. */
  name: string;
  /** The specifier of the module that it comes from. */
  source: string;
  /** The position of the import specifier, or of the namespace member. */
  start: number;
};

export type ModuleAnalysis = {
  table: ModuleTable;
  references: Reference[];
  /**
   * The local names that the module uses as values: free references, JSX
   * element names and local `export { x }` specifiers. An import whose
   * bindings are not among them is used only in types, and TypeScript
   * removes it.
   */
  valueNames: Set<string>;
  marked: MarkedReference[];
  declaration?: Declaration;
  /**
   * The first resource function that the module imports, if any. Such a
   * module is an infra module, whether it calls the function at its top
   * level or only inside a function.
   */
  resource?: ResourceImport;
};

/**
 * Reads the declaration of a module, and the first resource function that
 * it imports.
 */
export function analyzeModule(
  table: ModuleTable,
  marks: Marks,
): ModuleAnalysis {
  const { module } = table;
  const references = module.body.flatMap((statement) =>
    freeReferences(statement),
  );
  const marked = references.flatMap((reference) => {
    const found = markOf(reference, table, marks);
    return found ? [{ ...reference, ...found }] : [];
  });

  const fail = (node: Node, message: string): never => {
    throw new Error(
      `${module.file}:${location(module.source, node.start)}: ${message}`,
    );
  };

  const declarations: Declaration[] = [];
  for (const reference of marked) {
    const { mark } = reference;
    if (mark.kind !== "declaration") continue;
    if (insideMarkedWrapper(reference, table)) continue;
    declarations.push(readDeclaration(reference, mark, fail));
  }

  if (declarations.length > 1) {
    const where = declarations.map(
      (d) => `${d.name} at ${location(module.source, d.call.start)}`,
    );
    throw new Error(
      `${module.file}: the module has more than one declaration (${where.join(", ")}). Put each declaration in its own module.`,
    );
  }

  const valueNames = new Set(references.map(({ node }) => node.name));
  for (const target of table.exports.values()) {
    if ("local" in target) valueNames.add(target.local);
  }
  if (/\.[cm]?[jt]sx$/.test(module.file)) {
    for (const statement of module.body) jsxNames(statement, valueNames);
  }

  return {
    table,
    references,
    valueNames,
    marked,
    declaration: declarations[0],
    resource: resourceImport(table, valueNames, marked, marks),
  };
}

// Adds the names of JSX elements, such as `Orders` in `<Orders />` and
// `ui` in `<ui.Orders />`, which `freeReferences` doesn't visit.
function jsxNames(node: Node, names: Set<string>) {
  if (node.type === "JSXOpeningElement") {
    let name = node.name;
    while (name.type === "JSXMemberExpression") name = name.object;
    if (name.type === "JSXIdentifier") names.add(name.name);
  }
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item && typeof item.type === "string") jsxNames(item, names);
      }
    } else if (value && typeof value.type === "string") {
      jsxNames(value, names);
    }
  }
}

function resourceImport(
  table: ModuleTable,
  valueNames: Set<string>,
  marked: MarkedReference[],
  marks: Marks,
): ResourceImport | undefined {
  const file = module(table);
  for (const [local, binding] of table.imports) {
    if (binding.imported === "*" || !valueNames.has(local)) continue;
    if (marks.importMark(file, binding)?.kind === "resource") {
      return {
        name: local,
        source: binding.source,
        start: binding.specifier.start,
      };
    }
  }
  // A namespace import counts through the members that the module uses,
  // such as `sqs.queue`.
  for (const reference of marked) {
    const binding = table.imports.get(reference.node.name);
    if (reference.mark.kind === "resource" && binding?.imported === "*") {
      return {
        name: reference.name,
        source: binding.source,
        start: reference.node.start,
      };
    }
  }
  for (const statement of table.module.body) {
    if (
      statement.type !== "ExportNamedDeclaration" ||
      !statement.source ||
      statement.exportKind === "type"
    )
      continue;
    const resolved = marks.resolve(statement.source.value, file);
    if (!resolved) continue;
    for (const specifier of statement.specifiers) {
      if (specifier.exportKind === "type") continue;
      const imported = specifier.local;
      const name =
        imported.type === "Identifier" ? imported.name : imported.value;
      if (marks.exportMark(resolved, name)?.kind === "resource") {
        return { name, source: statement.source.value, start: specifier.start };
      }
    }
  }
  // `export * from` and `export * as ns from` re-export every resource
  // function of the module.
  for (const statement of table.module.body) {
    if (
      statement.type !== "ExportAllDeclaration" ||
      statement.exportKind === "type"
    )
      continue;
    const resolved = marks.resolve(statement.source.value, file);
    const name = resolved && marks.resourceExport(resolved);
    if (name) {
      return { name, source: statement.source.value, start: statement.start };
    }
  }
  return undefined;
}

function markOf(
  reference: Reference,
  table: ModuleTable,
  marks: Marks,
): Omit<MarkedReference, keyof Reference> | undefined {
  const { node, ancestors } = reference;
  const name = node.name;
  const parent = ancestors.at(-1);
  let mark = table.marks.get(name);
  let callee: Node = node;
  let written = name;
  if (!mark) {
    const binding = table.imports.get(name);
    if (!binding) return undefined;
    if (binding.imported === "*") {
      if (
        parent?.type !== "MemberExpression" ||
        parent.computed ||
        parent.object !== node
      ) {
        return undefined;
      }
      mark = marks.importMark(
        module(table),
        binding,
        undefined,
        parent.property.name,
      );
      callee = parent;
      written = `${name}.${parent.property.name}`;
    } else {
      mark = marks.importMark(module(table), binding);
    }
  }
  if (!mark) return undefined;
  const calleeIndex = ancestors.indexOf(callee);
  const holder = callee === node ? parent : ancestors[calleeIndex - 1];
  const call =
    holder &&
    (holder.type === "CallExpression" || holder.type === "NewExpression") &&
    holder.callee === callee
      ? holder
      : undefined;
  return { mark, call, name: written };
}

const module = (table: ModuleTable) => table.module.file;

// A reference inside a marked function of the same module, such as a wrapper
// that calls `$lambda`, belongs to the wrapper's own declarations.
function insideMarkedWrapper(
  reference: Reference,
  table: ModuleTable,
): boolean {
  const [statement] = reference.ancestors;
  if (!statement || !reference.ancestors.some(isFunction)) return false;
  const declaration =
    statement.type === "ExportNamedDeclaration"
      ? statement.declaration
      : statement;
  if (!declaration) return false;
  const names =
    declaration.type === "VariableDeclaration"
      ? declaration.declarations.map((d: Node) => d.id.name)
      : [declaration.id?.name];
  return names.some(
    (name: string | undefined) =>
      name && table.marks.get(name)?.kind === "declaration",
  );
}

const shape = (name: string) =>
  `Declare it at the top level of the module, as \`const name = ${name}({ ... })\`, with an object literal.`;

function readDeclaration(
  reference: MarkedReference,
  mark: DeclarationMark,
  fail: (node: Node, message: string) => never,
): Declaration {
  const { call, name, ancestors } = reference;
  if (!call || call.type !== "CallExpression") {
    return fail(reference.node, `${name} can only be called. ${shape(name)}`);
  }
  // Skips parentheses and TS wrappers around the call, such as `satisfies`.
  let index = ancestors.indexOf(call) - 1;
  while (index >= 0 && unwrap(ancestors[index]!) === call) index--;
  const declarator = ancestors[index];
  const variableStatement = ancestors[index - 1];
  const top = ancestors[0]!;
  const isTopLevel =
    declarator?.type === "VariableDeclarator" &&
    unwrap(declarator.init) === call &&
    variableStatement?.type === "VariableDeclaration" &&
    variableStatement.declarations.length === 1 &&
    (top === variableStatement ||
      (top.type === "ExportNamedDeclaration" &&
        top.declaration === variableStatement));
  if (!isTopLevel || declarator.id.type !== "Identifier") {
    return fail(
      call,
      `${name} is called in an unsupported place. ${shape(name)}`,
    );
  }
  if (
    call.arguments.length !== 1 ||
    unwrap(call.arguments[0]).type !== "ObjectExpression"
  ) {
    return fail(
      call,
      `${name} takes one object literal of options. ${shape(name)}`,
    );
  }
  const options = unwrap(call.arguments[0]);
  const properties = new Map<string, Node>();
  for (const property of options.properties) {
    if (
      property.type !== "Property" ||
      property.computed ||
      property.kind !== "init"
    ) {
      return fail(
        property,
        `the options of ${name} can't use spread, computed keys or accessors, so that the build can find every option`,
      );
    }
    const key =
      property.key.type === "Identifier"
        ? property.key.name
        : String(property.key.value);
    properties.set(key, property);
  }
  return {
    mark,
    name,
    statement: top,
    binding: declarator.id.name,
    call,
    options,
    properties,
  };
}
