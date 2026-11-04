import ts from "typescript";

/** A binding that an import declaration makes. */
export type ImportBinding = {
  local: string;
  /** The imported name, `*` for a namespace import, or `default`. */
  imported: string;
  declaration: number;
};

export type ImportDeclaration = {
  index: number;
  source: string;
  /** The value of the `type` import attribute, if there is one. */
  attribute?: string;
  bindings: ImportBinding[];
  node: ts.ImportDeclaration;
};

/** `export { a as b }`, `export const a`, `export default ...`. */
export type LocalExport = {
  exported: string;
  local: string;
  /**
   * Whether the statement that declares the binding also exports it, as
   * `export const a` does. `export { a }` doesn't.
   */
  inline: boolean;
};

/** `export { a as b } from "./m"`, or `export * as b from "./m"`. */
export type ReExport = {
  exported: string;
  /** The name exported by the source module, or `*` for its namespace. */
  imported: string;
  source: string;
  attribute?: string;
  statement: number;
};

export type Statement = {
  index: number;
  node: ts.Statement;
  /** The top-level bindings that the statement declares. */
  declares: string[];
  /**
   * Each variable declarator's names and initializer, for finding bindings
   * that derive from infra calls. `export default <expr>` gives `default`.
   */
  initializers: Array<{
    names: string[];
    init: ts.Expression;
    /** The declarator's name, which may destructure the initializer. */
    pattern?: ts.BindingName;
  }>;
  /** Type-only statements, such as interfaces, have no effect. */
  typeOnly: boolean;
};

export type ModuleInfo = {
  path: string;
  sourceFile: ts.SourceFile;
  statements: Statement[];
  imports: ImportDeclaration[];
  importBindings: Map<string, ImportBinding>;
  /** The statement that declares each top-level binding. */
  declarations: Map<string, number>;
  localExports: LocalExport[];
  reExports: ReExport[];
  starExports: Array<{ source: string; attribute?: string; statement: number }>;
};

// The local name of `export default <expression>`.
export const defaultLocal = "*default*";

export function parseModule(path: string, source: string): ModuleInfo {
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.ESNext,
    true,
    scriptKind(path),
  );
  const info: ModuleInfo = {
    path,
    sourceFile,
    statements: [],
    imports: [],
    importBindings: new Map(),
    declarations: new Map(),
    localExports: [],
    reExports: [],
    starExports: [],
  };

  sourceFile.statements.forEach((node, index) => {
    const statement: Statement = {
      index,
      node,
      declares: [],
      initializers: [],
      typeOnly: false,
    };
    info.statements.push(statement);

    if (ts.isImportDeclaration(node)) {
      readImport(info, node, index);
      return;
    }
    if (ts.isExportDeclaration(node)) {
      readExportDeclaration(info, node, index);
      return;
    }
    if (ts.isExportAssignment(node)) {
      if (node.isExportEquals) return;
      statement.declares.push(defaultLocal);
      statement.initializers.push({
        names: [defaultLocal],
        init: node.expression,
      });
      info.localExports.push({
        exported: "default",
        local: defaultLocal,
        inline: true,
      });
      info.declarations.set(defaultLocal, index);
      return;
    }

    statement.typeOnly =
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      hasModifier(node, ts.SyntaxKind.DeclareKeyword);
    const exported = hasModifier(node, ts.SyntaxKind.ExportKeyword);
    const isDefault = hasModifier(node, ts.SyntaxKind.DefaultKeyword);

    if (ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) {
        const names = bindingNames(declaration.name);
        statement.declares.push(...names);
        if (declaration.initializer) {
          statement.initializers.push({
            names,
            init: declaration.initializer,
            pattern: declaration.name,
          });
        }
      }
    } else if (
      (ts.isFunctionDeclaration(node) ||
        ts.isClassDeclaration(node) ||
        ts.isEnumDeclaration(node) ||
        ts.isInterfaceDeclaration(node) ||
        ts.isTypeAliasDeclaration(node) ||
        ts.isModuleDeclaration(node)) &&
      node.name &&
      ts.isIdentifier(node.name)
    ) {
      statement.declares.push(node.name.text);
    } else if (
      isDefault &&
      (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node))
    ) {
      statement.declares.push(defaultLocal);
    }

    for (const name of statement.declares) {
      if (!info.declarations.has(name)) info.declarations.set(name, index);
    }
    if (exported && !statement.typeOnly) {
      if (isDefault) {
        const local = statement.declares[0] ?? defaultLocal;
        info.localExports.push({ exported: "default", local, inline: true });
      } else if (
        !ts.isInterfaceDeclaration(node) &&
        !ts.isTypeAliasDeclaration(node)
      ) {
        for (const name of statement.declares) {
          info.localExports.push({ exported: name, local: name, inline: true });
        }
      }
    }
  });
  return info;
}

/** The names of the module's own value exports, without `export *`. */
export function ownExportNames(info: ModuleInfo): string[] {
  return [
    ...info.localExports.map((exp) => exp.exported),
    ...info.reExports.map((exp) => exp.exported),
  ];
}

function readImport(
  info: ModuleInfo,
  node: ts.ImportDeclaration,
  index: number,
) {
  const declaration: ImportDeclaration = {
    index,
    source: (node.moduleSpecifier as ts.StringLiteral).text,
    attribute: readAttribute(node.attributes),
    bindings: [],
    node,
  };
  info.imports.push(declaration);
  const clause = node.importClause;
  if (!clause || clause.isTypeOnly) return;
  const add = (local: string, imported: string) => {
    const binding = { local, imported, declaration: index };
    declaration.bindings.push(binding);
    info.importBindings.set(local, binding);
  };
  if (clause.name) add(clause.name.text, "default");
  const named = clause.namedBindings;
  if (named && ts.isNamespaceImport(named)) add(named.name.text, "*");
  if (named && ts.isNamedImports(named)) {
    for (const element of named.elements) {
      if (element.isTypeOnly) continue;
      add(
        element.name.text,
        moduleExportName(element.propertyName ?? element.name),
      );
    }
  }
}

function readExportDeclaration(
  info: ModuleInfo,
  node: ts.ExportDeclaration,
  index: number,
) {
  if (node.isTypeOnly) return;
  const source = node.moduleSpecifier
    ? (node.moduleSpecifier as ts.StringLiteral).text
    : undefined;
  const attribute = readAttribute(node.attributes);
  const clause = node.exportClause;
  if (!clause) {
    if (source) info.starExports.push({ source, attribute, statement: index });
    return;
  }
  if (ts.isNamespaceExport(clause)) {
    info.reExports.push({
      exported: moduleExportName(clause.name),
      imported: "*",
      source: source!,
      attribute,
      statement: index,
    });
    return;
  }
  for (const element of clause.elements) {
    if (element.isTypeOnly) continue;
    const exported = moduleExportName(element.name);
    const local = moduleExportName(element.propertyName ?? element.name);
    if (source) {
      info.reExports.push({
        exported,
        imported: local,
        source,
        attribute,
        statement: index,
      });
    } else {
      info.localExports.push({ exported, local, inline: false });
    }
  }
}

function readAttribute(
  attributes: ts.ImportAttributes | undefined,
): string | undefined {
  for (const element of attributes?.elements ?? []) {
    if (element.name.text === "type" && ts.isStringLiteral(element.value)) {
      return element.value.text;
    }
  }
  return undefined;
}

function moduleExportName(name: ts.ModuleExportName): string {
  return name.text;
}

function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  const names: string[] = [];
  for (const element of name.elements) {
    if (ts.isOmittedExpression(element)) continue;
    names.push(...bindingNames(element.name));
  }
  return names;
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === kind)
  );
}

function scriptKind(path: string): ts.ScriptKind {
  if (/\.[cm]?tsx$/.test(path)) return ts.ScriptKind.TSX;
  if (/\.[cm]?jsx$/.test(path)) return ts.ScriptKind.JSX;
  if (/\.[cm]?js$/.test(path)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

/**
 * Follows a callee or initializer through property reads, element reads,
 * calls, `await` and type assertions to the identifier it starts from.
 * `called` says whether the chain passes through a call.
 */
export function chainRoot(
  expression: ts.Expression,
): { root: string; called: boolean } | undefined {
  let called = false;
  let current: ts.Expression = expression;
  for (;;) {
    if (
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isAwaitExpression(current)
    ) {
      current = current.expression;
    } else if (
      ts.isPropertyAccessExpression(current) ||
      ts.isElementAccessExpression(current)
    ) {
      current = current.expression;
    } else if (ts.isCallExpression(current)) {
      called = true;
      current = current.expression;
    } else if (ts.isIdentifier(current)) {
      return { root: current.text, called };
    } else {
      return undefined;
    }
  }
}

/**
 * The bindings that a top-level statement updates while the module body
 * runs: by assigning to them or a property of them, by calling a method on
 * them, or by passing them first to a method of `Object` or `Reflect`. Code
 * in function bodies doesn't count.
 */
export function topLevelUpdates(node: ts.Node): Set<string> {
  const updates = new Set<string>();
  const add = (expression: ts.Expression) => {
    const chain = chainRoot(expression);
    if (chain) updates.add(chain.root);
  };
  const visit = (child: ts.Node) => {
    if (isFunctionBody(child)) return;
    if (ts.isCallExpression(child)) {
      const callee = child.expression;
      if (
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        ["Object", "Reflect"].includes(callee.expression.text) &&
        child.arguments[0]
      ) {
        add(child.arguments[0]);
      } else if (
        ts.isPropertyAccessExpression(callee) ||
        ts.isElementAccessExpression(callee)
      ) {
        add(callee.expression);
      }
    }
    if (
      ts.isBinaryExpression(child) &&
      child.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      child.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ) {
      add(child.left);
    }
    if (
      (ts.isPrefixUnaryExpression(child) ||
        ts.isPostfixUnaryExpression(child)) &&
      (child.operator === ts.SyntaxKind.PlusPlusToken ||
        child.operator === ts.SyntaxKind.MinusMinusToken)
    ) {
      add(child.operand);
    }
    if (ts.isDeleteExpression(child)) add(child.expression);
    ts.forEachChild(child, visit);
  };
  visit(node);
  return updates;
}

export function isFunctionBody(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isConstructorDeclaration(node)
  );
}

/**
 * Whether an identifier can refer to a binding. Property names, keys, labels
 * and the names in import and export specifiers can't. Declared names, and
 * names in types, count, so callers that need to tell them apart check for
 * them.
 */
export function isReference(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) {
    return false;
  }
  if (
    (ts.isPropertyAssignment(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isGetAccessorDeclaration(parent) ||
      ts.isSetAccessorDeclaration(parent) ||
      ts.isEnumMember(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isMethodSignature(parent)) &&
    parent.name === node
  ) {
    return false;
  }
  if (ts.isBindingElement(parent) && parent.propertyName === node) {
    return false;
  }
  if (
    ts.isLabeledStatement(parent) ||
    ts.isBreakStatement(parent) ||
    ts.isContinueStatement(parent)
  ) {
    return false;
  }
  if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent)) {
    return false;
  }
  if (ts.isQualifiedName(parent) && parent.right === node) return false;
  return true;
}
