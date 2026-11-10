import { parseSync } from "rolldown/utils";

export type Node = {
  type: string;
  start: number;
  end: number;
  [key: string]: any;
};

export type Comment = {
  type: "Line" | "Block";
  value: string;
  start: number;
  end: number;
};

export type ParsedModule = {
  file: string;
  source: string;
  body: Node[];
  comments: Comment[];
};

/** Parses a JS or TS module. Throws with the first syntax error. */
export function parseModule(file: string, source: string): ParsedModule {
  const lang = /\.[cm]?tsx?$/.test(file)
    ? file.endsWith("x")
      ? "tsx"
      : "ts"
    : "js";
  const result = parseSync(file, source, { lang, sourceType: "module" });
  if (result.errors.length > 0) {
    const [error] = result.errors;
    throw new Error(`${file}: ${error!.message}`);
  }
  return {
    file,
    source,
    body: result.program.body as unknown as Node[],
    comments: result.comments as Comment[],
  };
}

/** The `line:column` of an offset, both counted from 1. */
export function location(source: string, offset: number): string {
  const before = source.slice(0, offset).split("\n");
  return `${before.length}:${before.at(-1)!.length + 1}`;
}

// Fields that only hold types. Types are erased, so names in them are not
// references.
const typeFields = new Set([
  "typeAnnotation",
  "typeParameters",
  "typeArguments",
  "returnType",
  "superTypeArguments",
  "implements",
]);

// TS nodes that wrap a value. Only their `expression` holds references.
const typeWrappers = new Set([
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSNonNullExpression",
  "TSTypeAssertion",
  "TSInstantiationExpression",
]);

// TS nodes that declare values, so they are walked like JS nodes.
const valueTsNodes = new Set([
  "TSEnumDeclaration",
  "TSEnumBody",
  "TSEnumMember",
  "TSModuleDeclaration",
  "TSModuleBlock",
  "TSParameterProperty",
  "TSExportAssignment",
]);

export function isNode(value: unknown): value is Node {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Node).type === "string" &&
    typeof (value as Node).start === "number"
  );
}

export function isFunction(node: Node): boolean {
  return (
    node.type === "FunctionDeclaration" ||
    node.type === "FunctionExpression" ||
    node.type === "ArrowFunctionExpression"
  );
}

/** Strips parentheses and TS wrappers such as `as` and `satisfies`. */
export function unwrap(node: Node): Node {
  while (
    node.type === "ParenthesizedExpression" ||
    typeWrappers.has(node.type)
  ) {
    node = node.expression;
  }
  return node;
}

/**
 * Calls `visit` for each node under `node`, in source order, skipping types.
 * `visit` returns `false` to skip the children of a node.
 */
export function walk(
  node: Node,
  visit: (
    node: Node,
    parent: Node | undefined,
    ancestors: Node[],
  ) => boolean | void,
  ancestors: Node[] = [],
): void {
  if (visit(node, ancestors.at(-1), ancestors) === false) return;
  if (node.type.startsWith("TS") && !valueTsNodes.has(node.type)) {
    if (typeWrappers.has(node.type)) {
      walk(node.expression, visit, [...ancestors, node]);
    }
    return;
  }
  const next = [...ancestors, node];
  for (const [key, value] of Object.entries(node)) {
    if (typeFields.has(key)) continue;
    if (Array.isArray(value)) {
      for (const item of value) if (isNode(item)) walk(item, visit, next);
    } else if (isNode(value)) {
      walk(value, visit, next);
    }
  }
}

/** The names that a binding pattern, such as `{ a, b: [c] }`, declares. */
export function patternNames(pattern: Node | null | undefined): string[] {
  if (!pattern) return [];
  switch (pattern.type) {
    case "Identifier":
      return [pattern.name];
    case "ObjectPattern":
      return pattern.properties.flatMap((property: Node) =>
        property.type === "RestElement"
          ? patternNames(property.argument)
          : patternNames(property.value),
      );
    case "ArrayPattern":
      return pattern.elements.flatMap((element: Node | null) =>
        patternNames(element),
      );
    case "RestElement":
      return patternNames(pattern.argument);
    case "AssignmentPattern":
      return patternNames(pattern.left);
    case "TSParameterProperty":
      return patternNames(pattern.parameter);
    default:
      return [];
  }
}

/** The names that a top-level statement declares, exported or not. */
export function declaredBy(statement: Node): string[] {
  const node =
    statement.type === "ExportNamedDeclaration"
      ? statement.declaration
      : statement;
  if (!node) return [];
  if (node.type === "VariableDeclaration") {
    return node.declarations.flatMap((declarator: Node) =>
      patternNames(declarator.id),
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

/** Whether a statement only declares, imports or exports types. */
export const isTypeOnly = (statement: Node): boolean =>
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

// The function-scoped names of a function: its parameters, its own name if
// it is a function expression, and the `var` declarations in its body,
// without those of nested functions.
function functionScope(fn: Node): string[] {
  const names = fn.params.flatMap((param: Node) => patternNames(param));
  if (fn.id && fn.type === "FunctionExpression") names.push(fn.id.name);
  if (!fn.body) return names;
  walk(fn.body, (node) => {
    if (isFunction(node)) return false;
    if (node.type === "VariableDeclaration" && node.kind === "var") {
      for (const declarator of node.declarations)
        names.push(...patternNames(declarator.id));
    }
  });
  return names;
}

// The block-scoped names that a list of statements declares. Modules are
// strict code, so a function declared in a block is scoped to the block.
function lexicalNames(statements: Node[]): string[] {
  return statements.flatMap((statement: Node) => {
    if (statement.type === "VariableDeclaration" && statement.kind !== "var")
      return statement.declarations.flatMap((declarator: Node) =>
        patternNames(declarator.id),
      );
    if (
      (statement.type === "FunctionDeclaration" ||
        statement.type === "ClassDeclaration") &&
      statement.id
    )
      return [statement.id.name];
    return [];
  });
}

// The names that a node declares for its own subtree.
function scopeOf(node: Node): string[] {
  if (isFunction(node)) return functionScope(node);
  switch (node.type) {
    case "BlockStatement":
    case "StaticBlock":
      return lexicalNames(node.body);
    case "SwitchStatement":
      return lexicalNames(
        node.cases.flatMap((switchCase: Node) => switchCase.consequent),
      );
    case "ForStatement":
      return node.init ? lexicalNames([node.init]) : [];
    case "ForInStatement":
    case "ForOfStatement":
      return lexicalNames([node.left]);
    case "CatchClause":
      return patternNames(node.param);
    case "ClassExpression":
      return node.id ? [node.id.name] : [];
    default:
      return [];
  }
}

// Whether an identifier is a name in a reference position, rather than a
// property name, a label or a binding.
function isReference(
  node: Node,
  parent: Node | undefined,
  key: string | undefined,
): boolean {
  if (!parent) return true;
  switch (parent.type) {
    case "MemberExpression":
      return key !== "property" || parent.computed;
    case "Property":
    case "MethodDefinition":
    case "PropertyDefinition":
    case "AccessorProperty":
      return key !== "key" || parent.computed;
    case "LabeledStatement":
    case "BreakStatement":
    case "ContinueStatement":
      return false;
    case "VariableDeclarator":
      return key !== "id";
    case "FunctionDeclaration":
    case "FunctionExpression":
    case "ArrowFunctionExpression":
      return key !== "id" && key !== "params";
    case "ClassDeclaration":
    case "ClassExpression":
      return key !== "id";
    case "CatchClause":
      return key !== "param";
    case "ImportSpecifier":
    case "ImportDefaultSpecifier":
    case "ImportNamespaceSpecifier":
    case "ExportSpecifier":
    case "MetaProperty":
      return false;
    default:
      return true;
  }
}

// Whether a JSX name refers to a binding: a tag such as `<Comp />`, or the
// object of `<ui.Comp />`. A tag that starts with a lowercase letter, such
// as `<div>`, names an element, not a binding. A closing tag repeats the
// opening tag, so it isn't counted again.
function isJsxReference(
  node: Node,
  ancestors: Node[],
  key: string | undefined,
): boolean {
  if (node.name === "this") return false;
  let index = ancestors.length - 1;
  const parent = ancestors[index];
  if (parent?.type === "JSXMemberExpression") {
    if (key !== "object") return false;
    while (ancestors[index]?.type === "JSXMemberExpression") index--;
    return ancestors[index]?.type === "JSXOpeningElement";
  }
  return (
    parent?.type === "JSXOpeningElement" &&
    key === "name" &&
    !/^[a-z]/.test(node.name)
  );
}

/** An identifier in a reference position, with the nodes above it. */
export type Reference = { node: Node; ancestors: Node[] };

/**
 * The identifiers under `node` that refer to a binding outside it. Names in
 * types, property names, labels and bindings don't count. A name declared
 * under `node` shadows the outer binding in its scope: a parameter or `var`
 * in its function, and a `let`, `const`, class or function declaration in
 * its block.
 * @param skip Nodes whose subtrees are left out.
 */
export function freeReferences(
  node: Node,
  skip: Set<Node> = new Set(),
): Reference[] {
  const found: Reference[] = [];
  const visit = (
    current: Node,
    ancestors: Node[],
    key: string | undefined,
    shadowed: Set<string>,
  ) => {
    if (skip.has(current)) return;
    if (current.type === "Identifier") {
      if (
        isReference(current, ancestors.at(-1), key) &&
        !shadowed.has(current.name)
      ) {
        found.push({ node: current, ancestors });
      }
      return;
    }
    if (current.type === "JSXIdentifier") {
      if (
        isJsxReference(current, ancestors, key) &&
        !shadowed.has(current.name)
      ) {
        found.push({ node: current, ancestors });
      }
      return;
    }
    const next = [...ancestors, current];
    if (current.type.startsWith("TS") && !valueTsNodes.has(current.type)) {
      if (typeWrappers.has(current.type))
        visit(current.expression, next, "expression", shadowed);
      return;
    }
    const declared = scopeOf(current);
    const scope =
      declared.length > 0 ? new Set([...shadowed, ...declared]) : shadowed;
    for (const [childKey, value] of Object.entries(current)) {
      if (typeFields.has(childKey)) continue;
      if (Array.isArray(value)) {
        for (const item of value) {
          if (isNode(item)) visitChild(item, next, childKey, scope);
        }
      } else if (isNode(value)) {
        visitChild(value, next, childKey, scope);
      }
    }
  };
  // A pattern holds bindings, but its defaults and computed keys hold
  // references.
  const visitPattern = (
    pattern: Node,
    ancestors: Node[],
    shadowed: Set<string>,
  ) => {
    if (skip.has(pattern)) return;
    const next = [...ancestors, pattern];
    switch (pattern.type) {
      case "ObjectPattern":
        for (const property of pattern.properties) {
          if (property.type === "RestElement") {
            visitPattern(property.argument, [...next, property], shadowed);
          } else {
            if (property.computed)
              visit(property.key, [...next, property], "key", shadowed);
            visitPattern(property.value, [...next, property], shadowed);
          }
        }
        return;
      case "ArrayPattern":
        for (const element of pattern.elements)
          if (element) visitPattern(element, next, shadowed);
        return;
      case "RestElement":
        return visitPattern(pattern.argument, next, shadowed);
      case "AssignmentPattern":
        visitPattern(pattern.left, next, shadowed);
        return visit(pattern.right, next, "right", shadowed);
      case "TSParameterProperty":
        return visitPattern(pattern.parameter, next, shadowed);
    }
  };
  const visitChild = (
    child: Node,
    ancestors: Node[],
    key: string,
    shadowed: Set<string>,
  ) => {
    const parent = ancestors.at(-1)!;
    const isPattern =
      (parent.type === "VariableDeclarator" && key === "id") ||
      (isFunction(parent) && key === "params") ||
      (parent.type === "CatchClause" && key === "param");
    if (isPattern) visitPattern(child, ancestors, shadowed);
    else visit(child, ancestors, key, shadowed);
  };
  visit(node, [], undefined, new Set());
  return found;
}

/** The JSDoc comment right before `start`, with only whitespace between. */
export function leadingJsDoc(
  module: ParsedModule,
  start: number,
): string | undefined {
  for (let i = module.comments.length - 1; i >= 0; i--) {
    const comment = module.comments[i]!;
    if (comment.end > start) continue;
    if (module.source.slice(comment.end, start).trim() !== "") return undefined;
    if (comment.type === "Block" && comment.value.startsWith("*"))
      return comment.value;
    return undefined;
  }
  return undefined;
}
