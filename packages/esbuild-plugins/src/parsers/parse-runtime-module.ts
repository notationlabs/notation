import ts from "typescript";

export type StaticValue =
  | string
  | number
  | boolean
  | null
  | StaticValue[]
  | { [key: string]: StaticValue };

export type RuntimeModuleResource = {
  service: string;
  id: string;
  [key: string]: StaticValue;
};

export type RuntimeModule = {
  resource: RuntimeModuleResource;
  /** The names of the module's value exports, without `resource`. */
  exports: string[];
};

type Export = { name: string; node: ts.Node };

const servicePattern = /^[a-z0-9-]+\/[A-Za-z_$][\w$]*$/;

/**
 * Reads a module that matched a runtime-module glob. Returns `undefined` when
 * the module does not export `resource`, so it is an ordinary module. Throws
 * when the module still exports `config`, or when `resource` cannot be read
 * without evaluating the module.
 * @param filePath Names the module in error messages.
 */
export function parseRuntimeModule(
  source: string,
  filePath: string,
): RuntimeModule | undefined {
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.ESNext,
    true,
  );
  const fail = (message: string): never => {
    throw new Error(`${filePath}: ${message}`);
  };

  const exports: Export[] = [];
  for (const statement of sourceFile.statements) {
    exports.push(...getExports(statement, fail));
  }

  const resourceExport = exports.find((exp) => exp.name === "resource");
  if (!resourceExport) {
    if (exports.some((exp) => exp.name === "config")) {
      fail(
        'rename the "config" export to "resource". A runtime module exports `resource`, e.g. `export const resource = { service: "aws/lambda", id: "todos" }`.',
      );
    }
    return undefined;
  }

  const resource = readResource(resourceExport.node, fail);
  const names = exports
    .map((exp) => exp.name)
    .filter((name) => name !== "resource");

  return { resource, exports: [...new Set(names)] };
}

function getExports(node: ts.Statement, fail: (m: string) => never): Export[] {
  if (ts.isExportAssignment(node)) {
    return fail("default exports are not supported in a runtime module");
  }

  if (ts.isExportDeclaration(node)) {
    if (node.isTypeOnly) return [];
    if (!node.exportClause) {
      return fail(
        "`export *` is not supported in a runtime module. Name each export.",
      );
    }
    if (ts.isNamespaceExport(node.exportClause)) {
      return [{ name: node.exportClause.name.text, node }];
    }
    return node.exportClause.elements
      .filter((element) => !element.isTypeOnly)
      .map((element) => {
        if (element.name.text === "default") {
          return fail("default exports are not supported in a runtime module");
        }
        if (element.name.text === "resource") {
          return fail(
            "`resource` must be declared with `export const resource = { ... }`",
          );
        }
        return { name: element.name.text, node: element };
      });
  }

  if (!hasExportModifier(node)) return [];
  if (hasModifier(node, ts.SyntaxKind.DefaultKeyword)) {
    return fail("default exports are not supported in a runtime module");
  }
  if (hasModifier(node, ts.SyntaxKind.DeclareKeyword)) return [];

  if (ts.isVariableStatement(node)) {
    return node.declarationList.declarations.map((declaration) => {
      if (!ts.isIdentifier(declaration.name)) {
        return fail(
          "destructured exports are not supported in a runtime module",
        );
      }
      return {
        name: declaration.name.text,
        node: declaration.initializer ?? declaration,
      };
    });
  }

  if (
    (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) &&
    node.name
  ) {
    return [{ name: node.name.text, node }];
  }

  if (
    ts.isEnumDeclaration(node) &&
    !hasModifier(node, ts.SyntaxKind.ConstKeyword)
  ) {
    return [{ name: node.name.text, node }];
  }

  return [];
}

function hasExportModifier(node: ts.Statement) {
  return hasModifier(node, ts.SyntaxKind.ExportKeyword);
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind) {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some((mod) => mod.kind === kind)
  );
}

function readResource(
  node: ts.Node,
  fail: (m: string) => never,
): RuntimeModuleResource {
  const expression = unwrap(node);
  if (!ts.isObjectLiteralExpression(expression)) {
    return fail("`resource` must be an object literal");
  }
  const resource = readValue(expression, "resource", fail) as Record<
    string,
    StaticValue
  >;

  const { service, id } = resource;
  if (service === undefined) {
    fail('`resource.service` is missing, e.g. `service: "aws/lambda"`');
  }
  if (typeof service !== "string" || !servicePattern.test(service)) {
    fail(
      `\`resource.service\` must be "<platform>/<service>", e.g. "aws/lambda", not ${JSON.stringify(service)}`,
    );
  }
  if (id === undefined) {
    fail(
      '`resource.id` is missing, e.g. `id: "todos"`. The id names the resource, so keep it stable: changing it replaces the resource.',
    );
  }
  if (typeof id !== "string" || id === "") {
    fail(`\`resource.id\` must be a string, not ${JSON.stringify(id)}`);
  }
  if ("code" in resource) {
    fail("`resource.code` is set by the compiler. Remove it.");
  }
  return resource as RuntimeModuleResource;
}

// Strips `as`, `satisfies` and parentheses, which do not change the value.
function unwrap(node: ts.Node): ts.Node {
  while (
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isParenthesizedExpression(node) ||
    ts.isTypeAssertionExpression(node)
  ) {
    node = node.expression;
  }
  return node;
}

// The compiler never evaluates a runtime module, so `resource` can only hold
// values that can be read from the source text.
function readValue(
  node: ts.Node,
  path: string,
  fail: (m: string) => never,
): StaticValue {
  node = unwrap(node);
  const notStatic = (): never =>
    fail(
      `\`${path}\` must be a literal value (a string, number, boolean, null, array or object), so it can be read without running the module`,
    );

  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (
    ts.isPrefixUnaryExpression(node) &&
    node.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(node.operand)
  ) {
    return -Number(node.operand.text);
  }
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;

  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.map((element, index) =>
      readValue(element, `${path}[${index}]`, fail),
    );
  }

  if (ts.isObjectLiteralExpression(node)) {
    const object: Record<string, StaticValue> = {};
    for (const property of node.properties) {
      if (!ts.isPropertyAssignment(property)) return notStatic();
      const key = readKey(property.name);
      if (key === undefined) return notStatic();
      object[key] = readValue(property.initializer, `${path}.${key}`, fail);
    }
    return object;
  }

  return notStatic();
}

function readKey(name: ts.PropertyName): string | undefined {
  if (
    ts.isIdentifier(name) ||
    ts.isStringLiteral(name) ||
    ts.isNumericLiteral(name)
  ) {
    return name.text;
  }
  return undefined;
}
