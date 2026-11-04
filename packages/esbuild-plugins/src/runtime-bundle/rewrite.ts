import ts from "typescript";
import type { PartialMessage } from "esbuild";
import {
  bindingKey,
  isKeySegment,
  outputKey,
} from "@notation/resource/outputs";
import {
  chainRoot,
  isFunctionBody,
  isReference,
  parseModule,
  topLevelUpdates,
} from "src/infra-phase/module-info";

export type RewriteOptions = {
  /** The specifiers of `type: "infra"` imports that name a provider. */
  providers: Set<string>;
  /**
   * The key of each local infra module, such as `infra/orders`, by the
   * specifier of a `type: "infra"` import of it.
   */
  infraModules: Map<string, string>;
  /** Where the rewritten code imports `read` from. */
  readSpecifier: string;
};

export type RewriteResult = {
  code: string;
  /** The output key of each read in the rewritten code. */
  reads: string[];
  /**
   * Calls to infra made while the module body runs, outside the settings of
   * a factory call. Each becomes a pure call with `id` as its argument, which
   * tree-shaking removes if its result is unused. One that is left in the
   * bundle fails the build with `error`.
   */
  infraCalls: Array<{ id: string; error: PartialMessage }>;
  errors: PartialMessage[];
};

type Edit = [start: number, end: number, text: string];

const readLocal = "__notationRead";
const infraCallLocal = "__notationInfraCall";

/**
 * Rewrites a module of a function's bundle, so that it keeps only runtime
 * code:
 *
 * 1. A `type: "infra"` import of a provider, such as `@notation/aws/lambda`,
 *    imports the provider's runtime half, `@notation/aws/lambda.fn`, and each
 *    call to one of its factories loses its arguments.
 * 2. Top-level declarations that only those arguments use are removed, and
 *    so are the statements that update them.
 * 3. Each use of a `type: "infra"` import of a local module becomes a pure
 *    call to `read`: `orderQueue.url` becomes
 *    `read("infra/orders#orderQueue", ["url"])`, and `orderQueue` used as a
 *    value becomes `read("infra/orders#orderQueue", [])`. The import is
 *    removed.
 *
 * A call to infra made while the module body runs, such as a grant in a
 * helper module's settings, becomes a pure placeholder call. Tree-shaking
 * removes it when only settings use its result. Calling infra in a function
 * body, assigning to it, using a namespace import of it as a value, or
 * re-exporting it is an error.
 */
export function rewriteRuntimeModule(
  file: string,
  source: string,
  opts: RewriteOptions,
): RewriteResult {
  const info = parseModule(file, source);
  const sourceFile = info.sourceFile;
  const edits: Edit[] = [];
  const errors: PartialMessage[] = [];
  const reads = new Set<string>();
  const infraCalls: RewriteResult["infraCalls"] = [];
  const fail = (node: ts.Node, text: string) => {
    errors.push({ text, location: locate(sourceFile, node) });
  };

  const factories = new Set<string>();
  const infra = new Map<string, { module: string; imported: string }>();
  let readImport: ts.ImportDeclaration | undefined;
  for (const decl of info.imports) {
    if (decl.attribute !== "infra") continue;
    if (opts.providers.has(decl.source)) {
      for (const binding of decl.bindings) factories.add(binding.local);
      const { moduleSpecifier, attributes } = decl.node;
      edits.push([
        moduleSpecifier.getStart(),
        attributes!.end,
        JSON.stringify(`${decl.source}.fn`),
      ]);
      continue;
    }
    const module = opts.infraModules.get(decl.source);
    if (module === undefined) continue;
    for (const binding of decl.bindings) {
      infra.set(binding.local, { module, imported: binding.imported });
    }
    readImport ??= decl.node;
    edits.push([decl.node.getStart(), decl.node.end, ""]);
  }
  for (const statement of info.statements) {
    const node = statement.node;
    if (!ts.isExportDeclaration(node)) continue;
    const specifier = node.moduleSpecifier;
    if (specifier && ts.isStringLiteral(specifier)) {
      if (opts.infraModules.has(specifier.text)) {
        fail(
          node,
          `Runtime code can't re-export ${specifier.text}, an infra module. Import the values it needs with { type: "infra" }.`,
        );
      }
      continue;
    }
    const clause = node.exportClause;
    if (!clause || !ts.isNamedExports(clause)) continue;
    for (const element of clause.elements) {
      const local = (element.propertyName ?? element.name).text;
      if (infra.has(local)) {
        fail(
          element,
          `Runtime code can't re-export ${local}, which it imports from infra.`,
        );
      }
    }
  }

  const argumentRanges: Array<[number, number]> = [];
  const findFactoryCalls = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const chain = chainRoot(node.expression);
      if (chain && !chain.called && factories.has(chain.root)) {
        argumentRanges.push([node.arguments.pos, node.arguments.end]);
        findFactoryCalls(node.expression);
        return;
      }
    }
    ts.forEachChild(node, findFactoryCalls);
  };
  if (factories.size > 0) findFactoryCalls(sourceFile);

  const removed = settingsOnlyStatements(info, argumentRanges);
  const statementRanges = [...removed].map((index) => {
    const node = sourceFile.statements[index]!;
    return [node.getStart(), node.end] as [number, number];
  });
  for (const [start, end] of statementRanges) edits.push([start, end, ""]);
  for (const [start, end] of argumentRanges) {
    if (!within(statementRanges, start)) edits.push([start, end, ""]);
  }
  const skipped = [...statementRanges, ...argumentRanges];

  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node)) return;
    if (within(skipped, node.getStart())) return;
    if (ts.isIdentifier(node) && infra.has(node.text)) {
      rewriteUse(node);
      return;
    }
    ts.forEachChild(node, visit);
  };

  const rewriteUse = (id: ts.Identifier) => {
    if (!isReference(id) || inType(id) || isShadowed(id)) return;
    const { module, imported } = infra.get(id.text)!;
    const levels: ts.Expression[] = [id];
    const segments: string[] = [];
    for (;;) {
      const top = levels.at(-1)!;
      const parent = top.parent;
      let segment: string | undefined;
      if (
        ts.isPropertyAccessExpression(parent) &&
        parent.expression === top &&
        ts.isIdentifier(parent.name)
      ) {
        segment = parent.name.text;
      } else if (
        ts.isElementAccessExpression(parent) &&
        parent.expression === top &&
        ts.isStringLiteralLike(parent.argumentExpression)
      ) {
        segment = parent.argumentExpression.text;
      }
      if (segment === undefined || !isKeySegment(segment)) break;
      segments.push(segment);
      levels.push(parent as ts.Expression);
    }

    const namespace = imported === "*";
    if (namespace && segments.length === 0) {
      fail(
        id,
        `${id.text} is a namespace import of infra, which runtime code can't use as a value. Read one of its exports instead, as in ${id.text}.<export>.`,
      );
      return;
    }
    const binding = namespace ? segments[0]! : imported;
    const offset = namespace ? 1 : 0;
    const path = segments.slice(offset);
    const top = levels.at(-1)!;
    const parent = top.parent;
    const text = top.getText(sourceFile);

    const called =
      ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) &&
        parent.expression === top) ||
      (ts.isTaggedTemplateExpression(parent) && parent.tag === top);
    let readPath = path;
    let end = top.end;
    if (called) {
      if (path.length <= 1) {
        if (inFunctionBody(parent)) {
          fail(
            parent,
            `${text}() calls infra from runtime code. Infra functions only run in the infra phase: call them in the settings of lambda(), as in grants: [orderQueue.grant(["SendMessage"])].`,
          );
          return;
        }
        const start = parent.getStart(sourceFile);
        const id = `notation:infra-call:${file}:${start}`;
        infraCalls.push({
          id,
          error: {
            text: `${text}() calls infra from runtime code, and the function's bundle keeps the call. Infra functions only run in the infra phase: use their results only in the settings of lambda(), as in grants: [orderQueue.grant(["SendMessage"])].`,
            location: locate(sourceFile, parent),
          },
        });
        edits.push([
          start,
          parent.end,
          `/* @__PURE__ */ ${infraCallLocal}(${JSON.stringify(id)})`,
        ]);
        skipped.push([start, parent.end]);
        return;
      }
      readPath = path.slice(0, -1);
      end = levels[offset + readPath.length]!.end;
    } else if (isWriteTarget(top)) {
      fail(
        top,
        `Runtime code can't change ${text}, which it reads from infra.`,
      );
      return;
    }

    reads.add(outputKey(module, binding, readPath));
    let call = `/* @__PURE__ */ ${readLocal}(${JSON.stringify(bindingKey(module, binding))}, ${JSON.stringify(readPath)})`;
    if (ts.isNewExpression(parent)) call = `(${call})`;
    if (ts.isShorthandPropertyAssignment(id.parent)) {
      call = `${id.text}: ${call}`;
    }
    edits.push([id.getStart(sourceFile), end, call]);
  };

  if (infra.size > 0) ts.forEachChild(sourceFile, visit);

  if (readImport) {
    const index = edits.findIndex(
      ([start]) => start === readImport!.getStart(),
    );
    edits[index]![2] =
      `import { read as ${readLocal} } from ${JSON.stringify(opts.readSpecifier)};`;
  }

  let code = "";
  let cursor = 0;
  for (const [start, end, text] of edits.sort((a, b) => a[0] - b[0])) {
    code += source.slice(cursor, start) + text;
    cursor = end;
  }
  code += source.slice(cursor);
  if (infraCalls.length > 0) {
    code += `\nfunction ${infraCallLocal}(id) { throw new Error("Infra was called from runtime code: " + id); }\n`;
  }
  return { code, reads: [...reads].sort(), infraCalls, errors };
}

/**
 * The top-level declarations that only the arguments of factory calls use,
 * directly or through other such declarations, and the top-level statements
 * that only update them. Exported declarations are kept.
 */
function settingsOnlyStatements(
  info: ReturnType<typeof parseModule>,
  argumentRanges: Array<[number, number]>,
): Set<number> {
  if (argumentRanges.length === 0) return new Set();
  const exported = new Set(info.localExports.map((exp) => exp.local));
  const references: Array<{ name: string; pos: number; statement: number }> =
    [];
  info.sourceFile.statements.forEach((statement, index) => {
    const visit = (node: ts.Node) => {
      if (ts.isIdentifier(node) && isReference(node) && !inType(node)) {
        references.push({
          name: node.text,
          pos: node.getStart(),
          statement: index,
        });
      }
      ts.forEachChild(node, visit);
    };
    if (!ts.isImportDeclaration(statement)) visit(statement);
  });

  const declarations = info.statements.filter(
    ({ node, declares, typeOnly }) =>
      !typeOnly &&
      declares.length > 0 &&
      !declares.some((name) => exported.has(name)) &&
      (ts.isVariableStatement(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isClassDeclaration(node)),
  );
  const usesOf = (index: number, declares: string[]) =>
    references.filter(
      (ref) => ref.statement !== index && declares.includes(ref.name),
    );

  // 1. The declarations that the arguments use, directly or through other
  //    such declarations.
  const used = new Set<number>();
  for (let changed = true; changed;) {
    changed = false;
    for (const { index, declares } of declarations) {
      if (used.has(index)) continue;
      const reaches = usesOf(index, declares).some(
        (ref) => within(argumentRanges, ref.pos) || used.has(ref.statement),
      );
      if (reaches) {
        used.add(index);
        changed = true;
      }
    }
  }

  // 2. Of those, and of the statements that update them, the ones that
  //    nothing else needs. Each starts removed, and is kept once something
  //    that stays needs it.
  const updates = new Map<number, Set<string>>();
  for (const { index, node, declares, typeOnly } of info.statements) {
    if (typeOnly || declares.length > 0) continue;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) continue;
    const names = topLevelUpdates(node);
    if (names.size > 0) updates.set(index, names);
  }
  const removed = new Set([...used, ...updates.keys()]);
  const removedNames = () =>
    new Set(
      declarations
        .filter(({ index }) => removed.has(index) && used.has(index))
        .flatMap(({ declares }) => declares),
    );
  for (let changed = true; changed;) {
    changed = false;
    const names = removedNames();
    for (const [index, updated] of updates) {
      if (removed.has(index) && [...updated].some((name) => !names.has(name))) {
        removed.delete(index);
        changed = true;
      }
    }
    for (const { index, declares } of declarations) {
      if (!removed.has(index)) continue;
      const needed = usesOf(index, declares).some(
        (ref) =>
          !within(argumentRanges, ref.pos) && !removed.has(ref.statement),
      );
      if (needed) {
        removed.delete(index);
        changed = true;
      }
    }
  }
  return removed;
}

function within(ranges: Array<[number, number]>, pos: number): boolean {
  return ranges.some(([start, end]) => pos >= start && pos < end);
}

function inFunctionBody(node: ts.Node): boolean {
  for (let current = node.parent; current; current = current.parent) {
    if (isFunctionBody(current)) return true;
  }
  return false;
}

function inType(node: ts.Node): boolean {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isTypeNode(current)) return true;
    if (ts.isStatement(current) || isFunctionBody(current)) return false;
  }
  return false;
}

function isWriteTarget(node: ts.Expression): boolean {
  const parent = node.parent;
  if (
    ts.isBinaryExpression(parent) &&
    parent.left === node &&
    parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment
  ) {
    return true;
  }
  if (
    (ts.isPrefixUnaryExpression(parent) ||
      ts.isPostfixUnaryExpression(parent)) &&
    (parent.operator === ts.SyntaxKind.PlusPlusToken ||
      parent.operator === ts.SyntaxKind.MinusMinusToken)
  ) {
    return true;
  }
  return ts.isDeleteExpression(parent);
}

// Whether a declaration between the identifier and the top level of the
// module gives its name another binding.
function isShadowed(id: ts.Identifier): boolean {
  const name = id.text;
  for (let current = id.parent; current; current = current.parent) {
    if (ts.isSourceFile(current)) return false;
    if (
      (ts.isFunctionExpression(current) || ts.isClassExpression(current)) &&
      current.name?.text === name
    ) {
      return true;
    }
    if (isFunctionBody(current)) {
      const fn = current as ts.FunctionLikeDeclaration;
      if (fn.parameters.some((param) => declaresName(param.name, name))) {
        return true;
      }
      if (fn.body && declaresVar(fn.body, name)) return true;
    }
    if (
      ts.isBlock(current) ||
      ts.isCaseClause(current) ||
      ts.isDefaultClause(current)
    ) {
      if (
        current.statements.some((statement) =>
          statementDeclares(statement, name),
        )
      ) {
        return true;
      }
    }
    if (
      (ts.isForStatement(current) ||
        ts.isForInStatement(current) ||
        ts.isForOfStatement(current)) &&
      current.initializer &&
      ts.isVariableDeclarationList(current.initializer) &&
      current.initializer.declarations.some((decl) =>
        declaresName(decl.name, name),
      )
    ) {
      return true;
    }
    if (
      ts.isCatchClause(current) &&
      current.variableDeclaration &&
      declaresName(current.variableDeclaration.name, name)
    ) {
      return true;
    }
  }
  return false;
}

// Whether a function body declares a name with `var`, in any of its blocks.
// `var` declarations are scoped to the function, not to their block.
function declaresVar(node: ts.Node, name: string): boolean {
  let found = false;
  const visit = (child: ts.Node) => {
    if (found || isFunctionBody(child) || ts.isClassLike(child)) return;
    if (
      ts.isVariableDeclarationList(child) &&
      !(child.flags & ts.NodeFlags.BlockScoped) &&
      child.declarations.some((decl) => declaresName(decl.name, name))
    ) {
      found = true;
      return;
    }
    ts.forEachChild(child, visit);
  };
  ts.forEachChild(node, visit);
  return found;
}

function statementDeclares(statement: ts.Statement, name: string): boolean {
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.some((decl) =>
      declaresName(decl.name, name),
    );
  }
  if (
    ts.isFunctionDeclaration(statement) ||
    ts.isClassDeclaration(statement) ||
    ts.isEnumDeclaration(statement)
  ) {
    return statement.name?.text === name;
  }
  return false;
}

function declaresName(binding: ts.BindingName, name: string): boolean {
  if (ts.isIdentifier(binding)) return binding.text === name;
  return binding.elements.some(
    (element) =>
      !ts.isOmittedExpression(element) && declaresName(element.name, name),
  );
}

function locate(sourceFile: ts.SourceFile, node: ts.Node) {
  const start = node.getStart(sourceFile);
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(start);
  const lineStart = sourceFile.getPositionOfLineAndCharacter(line, 0);
  const lineEnd = sourceFile.text.indexOf("\n", lineStart);
  return {
    file: sourceFile.fileName,
    line: line + 1,
    column: character,
    length: Math.max(
      1,
      Math.min(node.end, lineEnd === -1 ? node.end : lineEnd) - start,
    ),
    lineText: sourceFile.text.slice(
      lineStart,
      lineEnd === -1 ? undefined : lineEnd,
    ),
  };
}
