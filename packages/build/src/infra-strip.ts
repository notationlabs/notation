import path from "node:path";
import MagicString from "magic-string";
import type { ModuleAnalysis } from "./analyze";
import {
  declaredBy,
  freeReferences,
  isTypeOnly,
  location,
  unwrap,
  type Node,
  type Reference,
} from "./ast";
import { otherExports } from "./exports";
import type { Marks } from "./marks";
import type { ModuleAnalyses } from "./modules";
import {
  describeProvided,
  platformOf,
  providerOfModule,
  type PlatformName,
} from "./platforms";

/** The name of the helper that records the module of a declaration. */
export const declaredInHelper = "__notation_declaredIn";

const unnamedHelper = "__notation_unnamed";

/**
 * A copy of `declaredIn` from @notation/resource. The build appends it to
 * the user's module, so the module doesn't have to import a notation
 * package. A test checks that the two copies behave the same.
 */
export const declaredInSource = `
function ${declaredInHelper}(value, path, binding, moduleExports) {
  if ((typeof value === "object" && value !== null) || typeof value === "function") {
    Object.defineProperty(value, Symbol.for("@notation/declaredIn"), { value: { path, binding, ...moduleExports } });
  }
  return value;
}`;

const helper = `${declaredInSource}
function ${unnamedHelper}(message) {
  return () => { throw new Error(message); };
}
`;

/**
 * A module with an infra declaration, e.g.
 * `export const worker = $worker(...)`.
 */
export type DeclarationModule = {
  /** The absolute path of the module. */
  path: string;
  /** The local name of the binding that holds the declaration. */
  binding: string;
  /** The export that the platform calls, such as `handler`. */
  entry?: string;
  /** The runtime platform. Defaults to Node. */
  platform?: PlatformName;
};

// Returns the top-level statements that the infra build keeps:
// - the infra declaration
// - the statements that the infra declaration uses, and their imports
//
// A use inside an option that the `@declaration` tag lists under `runtime`,
// e.g. `class: Counter`, is ignored.
function keptStatements(analysis: ModuleAnalysis) {
  const declaration = analysis.declaration!;
  const { module } = analysis.table;
  const owners = new Map<string, Node>();
  for (const statement of module.body) {
    for (const name of declaredBy(statement)) owners.set(name, statement);
  }

  const kept = new Set<Node>([declaration.statement]);
  const usedImports = new Set<string>();
  const queue: Node[] = [declaration.statement];
  while (queue.length > 0) {
    const statement = queue.pop()!;
    for (const { node } of statementReferences(analysis, statement)) {
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

  const platform = declaration.mark.platform;
  const exports = otherExports(analysis);
  if (exports) platformOf(platform).checkExports?.(analysis, exports);
  const record = [
    path.relative(root, module.file).split(path.sep).join("/"),
    declaration.binding,
    ...(exports ? [{ exports, starExports: analysis.table.stars }] : []),
  ];
  replaceRuntimeOptions(s, analysis, owners);
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
      ...(entry && { entry }),
      ...(platform && { platform }),
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

// Replaces the value of each `runtime` option in the infra declaration with
// a function that throws. `class: Counter` becomes
// `class: function Counter() { throw ... }`, so `config.class.name` is still
// "Counter". A value that isn't an identifier, e.g. a class expression,
// becomes a function whose name is "".
function replaceRuntimeOptions(
  s: MagicString,
  analysis: ModuleAnalysis,
  owners: Map<string, Node>,
) {
  const declaration = analysis.declaration!;
  const { module, imports } = analysis.table;
  for (const option of declaration.mark.runtime) {
    const property = declaration.properties.get(option);
    if (!property) continue;
    const message = JSON.stringify(
      `${option} only runs in the function, not in the infra build.`,
    );
    const value = unwrap(property.value);
    const name =
      !property.method &&
      value.type === "Identifier" &&
      (owners.has(value.name) || imports.has(value.name))
        ? (value.name as string)
        : undefined;
    // In `{ class: () => {} }` JavaScript names the function "class". A
    // function that a helper call returns keeps the name "".
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

/** The import that causes the infra build to remove an identifier. */
export type ProvidedReason = {
  /** The module that only another platform provides, such as `cloudflare:workers`. */
  module: string;
  /** The project module that imports it. */
  file: string;
};

/**
 * The identifiers, exports and statements that the infra build removes from
 * a project module, because they depend on a module that only another
 * platform provides, e.g. `cloudflare:workers`.
 */
export type ProvidedRemoval = {
  names: Map<string, ProvidedReason>;
  exports: Map<string, ProvidedReason>;
  statements: Set<Node>;
  /** Returns a reason if the infra build removes the referenced identifier. */
  reasonFor: (reference: Reference) => ProvidedReason | undefined;
};

type ExportLookup = (
  source: string,
  name: string,
) => ProvidedReason | undefined;

const nameOf = (node: Node): string =>
  node.type === "Identifier" ? node.name : String(node.value);

function runtimeOptionNodes(analysis: ModuleAnalysis): Set<Node> {
  const skip = new Set<Node>();
  const declaration = analysis.declaration;
  if (!declaration) return skip;
  for (const option of declaration.mark.runtime) {
    const property = declaration.properties.get(option);
    if (property) skip.add(property);
  }
  return skip;
}

function statementReferences(analysis: ModuleAnalysis, statement: Node) {
  const declaration = analysis.declaration;
  return statement === declaration?.statement
    ? freeReferences(statement, runtimeOptionNodes(analysis))
    : freeReferences(statement);
}

// True for an import statement, and for an export statement that declares
// nothing, e.g. `export { a }`. The infra build removes specifiers from
// these statements, and never the whole statement.
const isModuleSyntax = (statement: Node) =>
  statement.type === "ImportDeclaration" ||
  statement.type === "ExportAllDeclaration" ||
  (statement.type === "ExportNamedDeclaration" && !statement.declaration);

// Finds what the infra build removes from one module:
// 1. Each identifier imported from a module that only another platform
//    provides, e.g. `DurableObject` from `cloudflare:workers`.
// 2. Each identifier imported from a project module that removes that
//    export. `lookup` returns the reason if it does.
// 3. Each top-level statement that uses a removed identifier, and the
//    identifiers that the statement declares. Step 3 repeats until it adds
//    no statement.
// 4. Each export of a removed identifier.
function providedRemoval(
  analysis: ModuleAnalysis,
  lookup: ExportLookup,
): ProvidedRemoval {
  const { table } = analysis;
  const file = table.module.file;
  const names = new Map<string, ProvidedReason>();
  const exports = new Map<string, ProvidedReason>();
  const statements = new Set<Node>();
  const namespaces = new Map<string, string>();
  for (const [local, binding] of table.imports) {
    if (providerOfModule(binding.source)) {
      names.set(local, { module: binding.source, file });
    } else if (binding.imported === "*") {
      namespaces.set(local, binding.source);
    } else {
      const reason = lookup(binding.source, binding.imported);
      if (reason) names.set(local, reason);
    }
  }
  const reasonFor = ({ node, ancestors }: Reference) => {
    const reason = names.get(node.name);
    if (reason) return reason;
    const source = namespaces.get(node.name);
    const parent = ancestors.at(-1);
    if (
      source === undefined ||
      parent?.type !== "MemberExpression" ||
      parent.computed ||
      parent.object !== node
    )
      return undefined;
    return lookup(source, parent.property.name);
  };

  const candidates = table.module.body
    .filter((statement) => !isModuleSyntax(statement) && !isTypeOnly(statement))
    .map((statement) => ({
      statement,
      references: statementReferences(analysis, statement),
    }));
  for (let changed = true; changed;) {
    changed = false;
    for (const { statement, references } of candidates) {
      if (statements.has(statement)) continue;
      const reason = references.map(reasonFor).find(Boolean);
      if (!reason) continue;
      statements.add(statement);
      changed = true;
      const declared =
        statement.type === "ExportDefaultDeclaration"
          ? statement.declaration.id
            ? [statement.declaration.id.name]
            : []
          : declaredBy(statement);
      for (const name of declared)
        if (!names.has(name)) names.set(name, reason);
      if (statement.type === "ExportDefaultDeclaration") {
        exports.set("default", reason);
      }
    }
  }

  if (analysis.declaration) {
    return { names, exports: new Map(), statements, reasonFor };
  }
  for (const [name, target] of table.exports) {
    const reason =
      "local" in target
        ? names.get(target.local)
        : providerOfModule(target.source)
          ? { module: target.source, file }
          : target.imported === "*"
            ? undefined
            : lookup(target.source, target.imported);
    if (reason) exports.set(name, reason);
  }
  return { names, exports, statements, reasonFor };
}

function dependencySources(analysis: ModuleAnalysis): string[] {
  const { table } = analysis;
  const sources = new Set<string>(table.stars);
  for (const binding of table.imports.values()) sources.add(binding.source);
  for (const target of table.exports.values()) {
    if ("source" in target) sources.add(target.source);
  }
  return [...sources].filter((source) => !providerOfModule(source));
}

/**
 * Caches the `ProvidedRemoval` of each project module. Modules that import
 * each other are computed together.
 */
export class ProvidedRemovals {
  #analyses: ModuleAnalyses;
  #results = new Map<
    string,
    { analysis: ModuleAnalysis; removal: ProvidedRemoval }
  >();

  constructor(analyses: ModuleAnalyses) {
    this.#analyses = analyses;
  }

  clear() {
    this.#results.clear();
  }

  /** Returns undefined if the module can't be analysed. */
  of(file: string): ProvidedRemoval | undefined {
    const analysis = this.#analyses.fromFile(file);
    if (!analysis) return undefined;
    const cached = this.#results.get(file);
    if (cached?.analysis === analysis) return cached.removal;
    // The module changed, so every cached result may be stale.
    if (cached) this.#results.clear();
    this.#solve(file);
    return this.#results.get(file)?.removal;
  }

  // Computes a module's removal again each time a module that it imports
  // removes another export. A removal only grows, so the loop ends.
  #solve(start: string) {
    const analyses = this.#analyses;
    const pending = new Map<string, ModuleAnalysis>();
    const importers = new Map<string, Set<string>>();
    const resolved = new Map<string, string | undefined>();
    const resolve = (source: string, importer: string) => {
      const key = `${importer}\0${source}`;
      if (!resolved.has(key)) {
        const target = providerOfModule(source)
          ? undefined
          : analyses.marks.resolve(source, importer);
        resolved.set(key, target);
      }
      return resolved.get(key);
    };

    const queue = [start];
    const queued = new Set(queue);
    while (queue.length > 0) {
      const file = queue.pop()!;
      const analysis = analyses.fromFile(file);
      if (!analysis) continue;
      pending.set(file, analysis);
      for (const source of dependencySources(analysis)) {
        const target = resolve(source, file);
        if (!target || this.#results.has(target)) continue;
        if (!importers.has(target)) importers.set(target, new Set());
        importers.get(target)!.add(file);
        if (!queued.has(target)) {
          queued.add(target);
          queue.push(target);
        }
      }
    }

    const state = new Map<string, ProvidedRemoval>();
    const removalOf = (file: string) =>
      state.get(file) ?? this.#results.get(file)?.removal;
    const analysisOf = (file: string) =>
      pending.get(file) ?? this.#results.get(file)?.analysis;
    // Returns the reason if `file` removes its export `name`. If `file`
    // doesn't list the export, it checks the files that `file` re-exports
    // with `export * from`.
    const exportReason = (
      file: string,
      name: string,
      seen: Set<string>,
    ): ProvidedReason | undefined => {
      if (seen.has(file)) return undefined;
      seen.add(file);
      const reason = removalOf(file)?.exports.get(name);
      if (reason) return reason;
      const analysis = analysisOf(file);
      if (!analysis || name === "default" || analysis.table.exports.has(name))
        return undefined;
      for (const star of analysis.table.stars) {
        const target = resolve(star, file);
        const found = target ? exportReason(target, name, seen) : undefined;
        if (found) return found;
      }
      return undefined;
    };

    const work = [...pending.keys()];
    const inWork = new Set(work);
    while (work.length > 0) {
      const file = work.pop()!;
      inWork.delete(file);
      const lookup: ExportLookup = (source, name) => {
        const target = resolve(source, file);
        return target ? exportReason(target, name, new Set()) : undefined;
      };
      const removal = providedRemoval(pending.get(file)!, lookup);
      const before = state.get(file)?.exports.size ?? 0;
      state.set(file, removal);
      if (removal.exports.size === before) continue;
      for (const importer of importers.get(file) ?? []) {
        if (pending.has(importer) && !inWork.has(importer)) {
          inWork.add(importer);
          work.push(importer);
        }
      }
    }
    for (const [file, removal] of state) {
      this.#results.set(file, { analysis: pending.get(file)!, removal });
    }
  }
}

/**
 * Fails if the infra declaration uses an identifier that the infra build
 * removes, e.g. `label: Counter.name` when `Counter` extends
 * `DurableObject`.
 */
export function checkProvidedUses(
  analysis: ModuleAnalysis,
  removal: ProvidedRemoval,
  show: (file: string) => string,
) {
  const declaration = analysis.declaration!;
  const { module, imports } = analysis.table;
  for (const reference of statementReferences(
    analysis,
    declaration.statement,
  )) {
    const reason = removal.reasonFor(reference);
    if (!reason) continue;
    const { node, ancestors } = reference;
    const parent = ancestors.at(-1);
    const name = removal.names.has(node.name)
      ? node.name
      : `${node.name}.${parent!.property.name}`;
    const why =
      imports.get(node.name)?.source === reason.module
        ? `it is imported from ${describeProvided(reason.module)}`
        : `it depends on ${describeProvided(reason.module)}${reason.file === module.file ? "" : ` (${show(reason.file)} imports it)`}`;
    const options = declaration.mark.runtime.map(
      (option) => `\`${option}: ${name}\``,
    );
    const fix =
      options.length > 0
        ? `Pass ${name} only as ${options.join(" or ")}, or move the value that you need to a file that doesn't import ${reason.module}.`
        : `Move the value that you need to a file that doesn't import ${reason.module}.`;
    throw new Error(
      `${show(module.file)}:${location(module.source, node.start)}: ${name} can't be used in a ${declaration.name}() call, which runs at deploy, because ${why}. ${fix}`,
    );
  }
}

/**
 * Removes from a module's source what `removal` lists. An import that loses
 * all its specifiers becomes a side-effect import, so the imported module
 * still runs. Returns undefined if nothing changes.
 */
export function stripProvided(
  analysis: ModuleAnalysis,
  removal: ProvidedRemoval,
): { code: string; map: ReturnType<MagicString["generateMap"]> } | undefined {
  const { module } = analysis.table;
  const { source } = module;
  const text = (node: Node) => source.slice(node.start, node.end);
  const s = new MagicString(source);
  let changed = false;
  const replace = (statement: Node, replacement: string | undefined) => {
    changed = true;
    if (replacement === undefined) s.remove(statement.start, statement.end);
    else s.overwrite(statement.start, statement.end, replacement);
  };
  for (const statement of module.body) {
    if (removal.statements.has(statement)) {
      replace(statement, undefined);
      continue;
    }
    if (!statement.source || isTypeOnly(statement)) continue;
    const from = text(statement.source);
    const provided = providerOfModule(statement.source.value) !== undefined;
    const sideEffect = provided ? undefined : `import ${from};`;
    if (statement.type === "ImportDeclaration") {
      if (provided) {
        replace(statement, undefined);
        continue;
      }
      const used = new Set<string>();
      for (const specifier of statement.specifiers) {
        const local: string = specifier.local.name;
        if (!removal.names.has(local)) used.add(local);
      }
      if (used.size === statement.specifiers.length) continue;
      replace(statement, keptImport(statement, used, source) ?? sideEffect);
    } else if (statement.type === "ExportNamedDeclaration") {
      const specifiers = statement.specifiers.filter(
        (specifier: Node) =>
          specifier.exportKind === "type" ||
          !removal.exports.has(nameOf(specifier.exported)),
      );
      if (specifiers.length === statement.specifiers.length) continue;
      replace(
        statement,
        specifiers.length > 0
          ? `export { ${specifiers.map(text).join(", ")} } from ${from};`
          : sideEffect,
      );
    }
  }
  // Export lists without a source, such as `export { C, NAME }`.
  for (const statement of module.body) {
    if (
      statement.type !== "ExportNamedDeclaration" ||
      statement.declaration ||
      statement.source ||
      isTypeOnly(statement)
    )
      continue;
    const specifiers = statement.specifiers.filter(
      (specifier: Node) =>
        specifier.exportKind === "type" ||
        !removal.names.has(nameOf(specifier.local)),
    );
    if (specifiers.length === statement.specifiers.length) continue;
    replace(
      statement,
      specifiers.length > 0
        ? `export { ${specifiers.map(text).join(", ")} };`
        : undefined,
    );
  }
  if (!changed) return undefined;
  return {
    code: s.toString(),
    map: s.generateMap({
      hires: true,
      source: module.file,
      includeContent: true,
    }),
  };
}
