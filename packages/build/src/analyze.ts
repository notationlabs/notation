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

export type ModuleAnalysis = {
  table: ModuleTable;
  references: Reference[];
  marked: MarkedReference[];
  declaration?: Declaration;
  /**
   * The first call to a resource function at the top level of the module.
   * Errors use it to say how to leave the call out of a function.
   */
  resourceCall?: MarkedReference;
};

/**
 * Reads the declaration of a module, and its first call to a resource
 * function at its top level.
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
  let resourceCall: MarkedReference | undefined;
  for (const reference of marked) {
    const { mark } = reference;
    if (mark.kind === "resource") {
      if (reference.call && !reference.ancestors.some(isFunction))
        resourceCall ??= reference;
      continue;
    }
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

  return {
    table,
    references,
    marked,
    declaration: declarations[0],
    resourceCall,
  };
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
