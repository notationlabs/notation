import ts from "typescript";
import {
  chainRoot,
  defaultLocal,
  isFunctionBody,
  isReference,
  ownExportNames,
  parseModule,
  type ModuleInfo,
} from "./module-info";
import { exportName } from "src/utils/script";

/**
 * Where an import specifier leads. `local` is false for packages and other
 * modules that the bundle leaves external.
 */
export type Resolved = { path: string; local: boolean };

export type StripOptions = {
  getFile: (path: string) => string | Promise<string>;
  resolve: (specifier: string, importer: string) => Promise<Resolved>;
  /** Whether a path is a runtime module, which `type: "infra"` can't import. */
  isRuntimeModule: (path: string) => boolean;
  /** Names a path in error messages. */
  describe: (path: string) => string;
};

export type StrippedModules = {
  /** The stripped source of each module that the infra phase loads. */
  modules: Map<string, string>;
  /** Every file that the analysis read. */
  files: string[];
  /**
   * The local modules that the runtime modules, and the local modules they
   * import, import `with { type: "infra" }`, sorted.
   */
  infraModules: string[];
};

/** The specifier prefix of a stripped copy in generated code. */
export const strippedPrefix = "notation-stripped:";

// Replaces the arguments of calls on a derived binding, so handler bodies
// never run in the infra phase.
const inert = "__notationInert";
const inertDeclaration = `const ${inert} = () => { throw new Error("A handler doesn't run in the infra phase."); };`;

type Kind = "infra" | "derived" | "plain";

type ModuleState = {
  info: ModuleInfo;
  resolved: Map<string, Resolved>;
  visited: boolean;
  kept: Set<number>;
  keptImports: Set<string>;
  requested: Set<string>;
};

/**
 * Makes the stripped copy of each runtime module, and of each local module
 * that a copy imports. Per top-level statement, a copy keeps:
 *
 * 1. Calls to `type: "infra"` imports, or to bindings derived from them, made
 *    while the module body runs.
 * 2. Declarations derived from those calls, and exports of them. A binding
 *    is derived when its value comes from such a call, across files.
 * 3. Everything a kept statement references.
 * 4. Statements that update a kept binding.
 *
 * Calls on a derived binding have their arguments replaced with an inert
 * placeholder. A local module that a copy imports is stripped the same way,
 * rooted at the names that the copy imports, and its dropped exports become
 * `undefined`.
 * @param entries The absolute paths of the runtime modules.
 */
export async function stripRuntimeModules(
  entries: string[],
  opts: StripOptions,
): Promise<StrippedModules> {
  const states = await loadGraph(entries, opts);
  const analysis = new Analysis(states, opts);
  for (const entry of entries) analysis.visit(entry);
  analysis.applyUpdates();

  const modules = new Map<string, string>();
  for (const [path, state] of states) {
    if (state.visited) modules.set(path, analysis.generate(state));
  }
  const infraModules = new Set<string>();
  for (const state of states.values()) {
    const { info, resolved } = state;
    for (const decl of [...info.imports, ...info.reExports]) {
      const target = resolved.get(decl.source);
      if (decl.attribute === "infra" && target?.local) {
        infraModules.add(target.path);
      }
    }
  }
  return {
    modules,
    files: [...states.keys()],
    infraModules: [...infraModules].sort(),
  };
}

// Parses the entries and every local module that they reach through imports
// and re-exports without an attribute.
async function loadGraph(
  entries: string[],
  opts: StripOptions,
): Promise<Map<string, ModuleState>> {
  const states = new Map<string, ModuleState>();
  const pending = [...entries];
  while (pending.length > 0) {
    const path = pending.shift()!;
    if (states.has(path)) continue;
    const info = parseModule(path, await opts.getFile(path));
    const state: ModuleState = {
      info,
      resolved: new Map(),
      visited: false,
      kept: new Set(),
      keptImports: new Set(),
      requested: new Set(),
    };
    states.set(path, state);

    const sources = [
      ...info.imports.map((decl) => [decl.source, decl.attribute] as const),
      ...info.reExports.map((exp) => [exp.source, exp.attribute] as const),
      ...info.starExports.map((exp) => [exp.source, exp.attribute] as const),
    ];
    for (const [source, attribute] of sources) {
      if (state.resolved.has(source)) continue;
      if (attribute === "runtime") {
        throw new Error(
          `${opts.describe(path)} imports ${source} with { type: "runtime" }, which is only valid in infra modules. Import the module without an attribute.`,
        );
      }
      const resolved = await opts.resolve(source, path);
      state.resolved.set(source, resolved);
      if (attribute === "infra") {
        if (resolved.local && opts.isRuntimeModule(resolved.path)) {
          throw new Error(
            `${opts.describe(path)} imports ${source} with { type: "infra" }, but it is a runtime module. Import it without an attribute.`,
          );
        }
        continue;
      }
      if (attribute === undefined && resolved.local)
        pending.push(resolved.path);
    }
  }
  return states;
}

class Analysis {
  #kinds = new Map<string, Kind>();
  #exportNames = new Map<string, Set<string>>();

  constructor(
    readonly states: Map<string, ModuleState>,
    readonly opts: StripOptions,
  ) {}

  visit(path: string): ModuleState {
    const state = this.states.get(path)!;
    if (state.visited) return state;
    state.visited = true;
    const { info } = state;
    for (const statement of info.statements) {
      if (statement.typeOnly) continue;
      const node = statement.node;
      if (ts.isImportDeclaration(node)) continue;
      if (ts.isExportDeclaration(node)) {
        if (!node.exportClause && node.moduleSpecifier) {
          this.keep(state, statement.index);
        }
        continue;
      }
      if (
        this.#callsInfra(state, node) ||
        statement.declares.some(
          (name) => this.bindingKind(state, name) === "derived",
        )
      ) {
        this.keep(state, statement.index);
      }
    }
    for (const exp of info.reExports) {
      if (this.exportKind(state, exp.exported) === "derived") {
        this.request(state, exp.exported);
      }
    }
    for (const exp of info.localExports) {
      if (this.bindingKind(state, exp.local) === "derived") {
        this.request(state, exp.exported);
      }
    }
    return state;
  }

  request(state: ModuleState, name: string): void {
    this.visit(state.info.path);
    if (state.requested.has(name)) return;
    state.requested.add(name);
    const { info } = state;
    const local = info.localExports.find((exp) => exp.exported === name);
    if (local) return this.keepBinding(state, local.local);
    const reExport = info.reExports.find((exp) => exp.exported === name);
    if (reExport) {
      const target = this.#localTarget(
        state,
        reExport.source,
        reExport.attribute,
      );
      if (!target) return;
      if (reExport.imported === "*") return this.requestAll(target);
      return this.request(target, reExport.imported);
    }
    for (const star of info.starExports) {
      const target = this.#localTarget(state, star.source, star.attribute);
      if (target && this.exportNames(target).has(name)) {
        return this.request(target, name);
      }
    }
  }

  requestAll(state: ModuleState): void {
    this.visit(state.info.path);
    for (const name of this.exportNames(state)) this.request(state, name);
  }

  keepBinding(state: ModuleState, local: string): void {
    const binding = state.info.importBindings.get(local);
    if (binding) {
      if (state.keptImports.has(local)) return;
      state.keptImports.add(local);
      const decl = state.info.imports.find(
        (decl) => decl.index === binding.declaration,
      )!;
      const target = this.#localTarget(state, decl.source, decl.attribute);
      if (!target) return;
      if (binding.imported === "*") this.requestAll(target);
      else this.request(target, binding.imported);
      return;
    }
    const index = state.info.declarations.get(local);
    if (index !== undefined) this.keep(state, index);
  }

  keep(state: ModuleState, index: number): void {
    if (state.kept.has(index)) return;
    state.kept.add(index);
    const star = state.info.starExports.find((exp) => exp.statement === index);
    if (star) {
      const target = this.#localTarget(state, star.source, star.attribute);
      if (target) this.visit(target.info.path);
      return;
    }
    const statement = state.info.statements[index]!;
    for (const name of this.#scan(state, statement.node).refs) {
      this.keepBinding(state, name);
    }
  }

  /** Keeps statements that update a kept binding, until none is left. */
  applyUpdates(): void {
    for (let changed = true; changed;) {
      changed = false;
      for (const state of this.states.values()) {
        if (!state.visited) continue;
        const kept = this.#keptBindings(state);
        for (const statement of state.info.statements) {
          if (state.kept.has(statement.index) || statement.typeOnly) continue;
          const node = statement.node;
          if (
            ts.isImportDeclaration(node) ||
            ts.isExportDeclaration(node) ||
            statement.declares.length > 0
          ) {
            continue;
          }
          const { updates } = this.#scan(state, node);
          if ([...updates].some((name) => kept.has(name))) {
            this.keep(state, statement.index);
            changed = true;
          }
        }
      }
    }
  }

  bindingKind(state: ModuleState, local: string): Kind {
    const key = `${state.info.path}#${local}`;
    const known = this.#kinds.get(key);
    if (known) return known;
    // A cycle counts as plain until it resolves.
    this.#kinds.set(key, "plain");
    const kind = this.#bindingKind(state, local);
    this.#kinds.set(key, kind);
    return kind;
  }

  #bindingKind(state: ModuleState, local: string): Kind {
    const { info } = state;
    const binding = info.importBindings.get(local);
    if (binding) {
      const decl = info.imports.find((d) => d.index === binding.declaration)!;
      if (decl.attribute === "infra") return "infra";
      const target = this.#localTarget(state, decl.source, decl.attribute);
      if (!target) return "plain";
      if (binding.imported === "*") {
        return [...this.exportNames(target)].some(
          (name) => this.exportKind(target, name) === "derived",
        )
          ? "derived"
          : "plain";
      }
      return this.exportKind(target, binding.imported);
    }
    const index = info.declarations.get(local);
    if (index === undefined) return "plain";
    const statement = info.statements[index]!;
    const initializer = statement.initializers.find((init) =>
      init.names.includes(local),
    );
    if (!initializer) return "plain";
    const chain = chainRoot(initializer.init);
    if (!chain) return "plain";
    const rootKind = this.bindingKind(state, chain.root);
    if (rootKind === "derived") return "derived";
    if (rootKind === "infra" && chain.called) return "derived";
    return "plain";
  }

  exportKind(state: ModuleState, name: string): Kind {
    const { info } = state;
    const local = info.localExports.find((exp) => exp.exported === name);
    if (local) return this.bindingKind(state, local.local);
    const reExport = info.reExports.find((exp) => exp.exported === name);
    if (reExport) {
      if (reExport.attribute === "infra") return "infra";
      const target = this.#localTarget(
        state,
        reExport.source,
        reExport.attribute,
      );
      if (!target || reExport.imported === "*") return "plain";
      return this.exportKind(target, reExport.imported);
    }
    for (const star of info.starExports) {
      const target = this.#localTarget(state, star.source, star.attribute);
      if (target && this.exportNames(target).has(name)) {
        return this.exportKind(target, name);
      }
    }
    return "plain";
  }

  /** The module's value export names, following `export *`. */
  exportNames(state: ModuleState): Set<string> {
    const path = state.info.path;
    const known = this.#exportNames.get(path);
    if (known) return known;
    const names = new Set<string>();
    this.#exportNames.set(path, names);
    for (const name of ownExportNames(state.info)) names.add(name);
    for (const star of state.info.starExports) {
      const target = this.#localTarget(state, star.source, star.attribute);
      if (!target) continue;
      for (const name of this.exportNames(target)) {
        if (name !== "default") names.add(name);
      }
    }
    return names;
  }

  generate(state: ModuleState): string {
    const { info } = state;
    const text = info.sourceFile.text;
    const lines: string[] = [];
    let needsInert = false;
    let dropped = 0;
    const exportUndefined = (exported: string) => {
      if (exported === "default") {
        lines.push("export default undefined;");
        return;
      }
      const name = `__notationDropped${dropped++}`;
      lines.push(
        `const ${name} = undefined;`,
        `export { ${name} as ${exportName(exported)} };`,
      );
    };

    for (const decl of info.imports) {
      const kept = decl.bindings.filter((b) => state.keptImports.has(b.local));
      if (kept.length === 0) continue;
      const from = this.#specifier(state, decl.source, decl.attribute);
      for (const binding of kept) {
        if (binding.imported === "*") {
          lines.push(`import * as ${binding.local} from ${from};`);
        } else {
          lines.push(
            `import { ${exportName(binding.imported)} as ${binding.local} } from ${from};`,
          );
        }
      }
    }

    for (const statement of info.statements) {
      if (!state.kept.has(statement.index)) continue;
      const node = statement.node;
      if (ts.isExportDeclaration(node)) {
        if (!node.exportClause && node.moduleSpecifier) {
          const star = info.starExports.find(
            (exp) => exp.statement === statement.index,
          )!;
          lines.push(
            `export * from ${this.#specifier(state, star.source, star.attribute)};`,
          );
        }
        continue;
      }
      const { replacements } = this.#scan(state, node);
      if (replacements.length > 0) needsInert = true;
      let out = "";
      let cursor = node.getStart();
      for (const [start, end] of replacements) {
        out += text.slice(cursor, start) + inert;
        cursor = end;
      }
      out += text.slice(cursor, node.end);
      lines.push(out);
    }

    const keptBindings = this.#keptBindings(state);
    for (const exp of info.localExports) {
      const kept = keptBindings.has(exp.local);
      if (kept && exp.inline) continue;
      if (kept) {
        lines.push(`export { ${exp.local} as ${exportName(exp.exported)} };`);
      } else {
        exportUndefined(exp.exported);
      }
    }
    for (const exp of info.reExports) {
      if (!state.requested.has(exp.exported)) {
        exportUndefined(exp.exported);
        continue;
      }
      const from = this.#specifier(state, exp.source, exp.attribute);
      lines.push(
        exp.imported === "*"
          ? `export * as ${exportName(exp.exported)} from ${from};`
          : `export { ${exportName(exp.imported)} as ${exportName(exp.exported)} } from ${from};`,
      );
    }

    if (needsInert) lines.unshift(inertDeclaration);
    return `${lines.join("\n")}\n`;
  }

  #keptBindings(state: ModuleState): Set<string> {
    const names = new Set(state.keptImports);
    for (const index of state.kept) {
      for (const name of state.info.statements[index]!.declares)
        names.add(name);
    }
    return names;
  }

  #localTarget(
    state: ModuleState,
    source: string,
    attribute: string | undefined,
  ): ModuleState | undefined {
    if (attribute !== undefined) return undefined;
    const resolved = state.resolved.get(source);
    if (!resolved?.local) return undefined;
    return this.states.get(resolved.path);
  }

  #specifier(
    state: ModuleState,
    source: string,
    attribute: string | undefined,
  ): string {
    if (attribute === "infra") return JSON.stringify(source);
    if (attribute !== undefined) {
      return `${JSON.stringify(source)} with { type: ${JSON.stringify(attribute)} }`;
    }
    const target = this.#localTarget(state, source, attribute);
    if (target) return JSON.stringify(`${strippedPrefix}${target.info.path}`);
    return JSON.stringify(source);
  }

  #callsInfra(state: ModuleState, node: ts.Node): boolean {
    let found = false;
    const visit = (child: ts.Node) => {
      if (found || isFunctionBody(child)) return;
      if (ts.isCallExpression(child)) {
        const chain = chainRoot(child.expression);
        if (chain && this.bindingKind(state, chain.root) !== "plain") {
          found = true;
          return;
        }
      }
      ts.forEachChild(child, visit);
    };
    visit(node);
    return found;
  }

  #isDerivedCall(state: ModuleState, call: ts.CallExpression): boolean {
    const chain = chainRoot(call.expression);
    if (!chain) return false;
    const kind = this.bindingKind(state, chain.root);
    return kind === "derived" || (kind === "infra" && chain.called);
  }

  // Finds the bindings that a statement references, the argument lists to
  // replace, and the bindings that it updates while the module body runs.
  #scan(state: ModuleState, node: ts.Node) {
    const refs = new Set<string>();
    const updates = new Set<string>();
    const replacements: Array<[number, number]> = [];
    const addUpdate = (expression: ts.Expression) => {
      const chain = chainRoot(expression);
      if (chain) updates.add(chain.root);
    };
    const visit = (child: ts.Node, inFunction: boolean) => {
      if (ts.isExpressionWithTypeArguments(child)) {
        if (
          ts.isHeritageClause(child.parent) &&
          child.parent.token === ts.SyntaxKind.ExtendsKeyword
        ) {
          visit(child.expression, inFunction);
        }
        return;
      }
      if (ts.isTypeNode(child)) return;
      if (
        ts.isInterfaceDeclaration(child) ||
        ts.isTypeAliasDeclaration(child)
      ) {
        return;
      }
      if (ts.isIdentifier(child)) {
        if (isReference(child)) refs.add(child.text);
        return;
      }
      if (ts.isShorthandPropertyAssignment(child)) {
        refs.add(child.name.text);
        return;
      }
      if (ts.isCallExpression(child)) {
        if (this.#isDerivedCall(state, child)) {
          visit(child.expression, inFunction);
          replacements.push([child.arguments.pos, child.arguments.end]);
          return;
        }
        if (!inFunction) {
          const callee = child.expression;
          if (
            ts.isPropertyAccessExpression(callee) &&
            ts.isIdentifier(callee.expression) &&
            ["Object", "Reflect"].includes(callee.expression.text) &&
            child.arguments[0]
          ) {
            addUpdate(child.arguments[0]);
          } else if (
            ts.isPropertyAccessExpression(callee) ||
            ts.isElementAccessExpression(callee)
          ) {
            addUpdate(callee.expression);
          }
        }
      }
      if (!inFunction) {
        if (
          ts.isBinaryExpression(child) &&
          child.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
          child.operatorToken.kind <= ts.SyntaxKind.LastAssignment
        ) {
          addUpdate(child.left);
        }
        if (
          (ts.isPrefixUnaryExpression(child) ||
            ts.isPostfixUnaryExpression(child)) &&
          (child.operator === ts.SyntaxKind.PlusPlusToken ||
            child.operator === ts.SyntaxKind.MinusMinusToken)
        ) {
          addUpdate(child.operand);
        }
        if (ts.isDeleteExpression(child)) addUpdate(child.expression);
      }
      const nested = inFunction || isFunctionBody(child);
      ts.forEachChild(child, (grandchild) => visit(grandchild, nested));
    };
    visit(node, false);
    replacements.sort((a, b) => a[0] - b[0]);
    refs.delete(defaultLocal);
    return { refs, updates, replacements };
  }
}
