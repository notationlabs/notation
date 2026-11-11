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

// The code that runs at deploy that first needed a value: a reference in
// an infra declaration, or an import or re-export in a module that the
// infra build keeps whole.
type Origin = {
  file: string;
  /** The reference as written, such as `Counter` or `ns.Counter`. */
  name: string;
  node: Node;
};

/**
 * What the infra build keeps of a runtime module that has no declaration:
 * the exports that kept code imports, and the top-level statements that
 * they need.
 */
export type RuntimeStrip = {
  statements: Set<Node>;
  /** The local names of the imports that kept statements use. */
  imports: Set<string>;
  exports: Set<string>;
  /** True if kept code uses every export, e.g. through a namespace import. */
  all: boolean;
  /** True if a used export comes through `export * from`. */
  stars: boolean;
};

type StripState = RuntimeStrip & { owners: Map<string, Node> };

// The local name that a top-level statement gives to its default export,
// when the export has no name of its own.
const defaultLocal = "*default*";

function ownersOf(analysis: ModuleAnalysis): Map<string, Node> {
  const owners = new Map<string, Node>();
  for (const statement of analysis.table.module.body) {
    if (statement.type === "ExportDefaultDeclaration") {
      owners.set(defaultLocal, statement);
      const id = statement.declaration.id;
      if (id) owners.set(id.name, statement);
      continue;
    }
    for (const name of declaredBy(statement)) owners.set(name, statement);
  }
  return owners;
}

/**
 * Finds what the infra build keeps of each runtime module that has no
 * declaration. Runtime code doesn't run at deploy, so the build keeps only
 * what code that runs at deploy uses.
 *
 * 1. The roots are the infra entry and the declaration modules.
 * 2. A declaration module uses what its declaration refers to, except in
 *    `runtime:` options, and the statements that those names need.
 * 3. A module that isn't a runtime module, such as an infra or shared
 *    module, runs whole, so it uses every name that it imports.
 * 4. In a runtime module without a declaration, each used export keeps the
 *    statements that it needs. Their imports are used in turn.
 *
 * A module's kept statements only grow, so the work ends. The solve fails
 * the build when kept code in a declaration module or a stripped module
 * uses a name from a module that only another platform provides, such as
 * `cloudflare:workers`.
 */
export class RuntimeStrips {
  #analyses: ModuleAnalyses;
  #roots: () => string[];
  #solved:
    | { strips: Map<string, StripState>; analyses: Map<string, ModuleAnalysis> }
    | undefined;

  /** @param roots Returns the infra entry and the declaration modules. */
  constructor(analyses: ModuleAnalyses, roots: () => string[]) {
    this.#analyses = analyses;
    this.#roots = roots;
  }

  clear() {
    this.#solved = undefined;
  }

  /**
   * Returns what the infra build keeps of `analysis`, a runtime module
   * without a declaration. A module that kept code doesn't import keeps
   * nothing.
   */
  of(analysis: ModuleAnalysis): RuntimeStrip {
    const file = analysis.table.module.file;
    let solved = this.solve();
    // A module that changed since the solve has other nodes.
    const used = solved.analyses.get(file);
    if (used && used !== analysis) {
      this.clear();
      solved = this.solve();
    }
    return (
      solved.strips.get(file) ?? {
        statements: new Set(),
        imports: new Set(),
        exports: new Set(),
        all: false,
        stars: false,
      }
    );
  }

  solve() {
    if (this.#solved) return this.#solved;
    const analyses = this.#analyses;
    const strips = new Map<string, StripState>();
    const used = new Map<string, ModuleAnalysis>();
    const visited = new Set<string>();
    const work: { file: string; name?: string; origin?: Origin }[] = [];
    const whole = (file: string, name: string, node: Node): Origin => ({
      file,
      name,
      node,
    });
    // The `export ... from` statement of `source` in a module.
    const reexport = (analysis: ModuleAnalysis, source: string): Node =>
      analysis.table.module.body.find(
        (statement: Node) =>
          (statement.type === "ExportNamedDeclaration" ||
            statement.type === "ExportAllDeclaration") &&
          statement.source?.value === source,
      )!;

    const analysisOf = (file: string) => {
      const analysis = analyses.fromFile(file);
      if (analysis) used.set(file, analysis);
      return analysis;
    };
    const resolve = (source: string, importer: string) =>
      providerOfModule(source)
        ? undefined
        : analyses.marks.resolve(source, importer);
    const isStripped = (file: string, analysis: ModuleAnalysis) =>
      !analysis.declaration && analyses.files.kindOf(file)?.kind === "runtime";

    // Records a use of the import `local` in `file`. `reference` is the use,
    // for a member of a namespace import such as `ns.Counter`.
    const useImport = (
      file: string,
      local: string,
      origin: Origin,
      reference?: Reference,
    ) => {
      const binding = analysisOf(file)!.table.imports.get(local)!;
      if (providerOfModule(binding.source)) {
        this.#fail(origin, binding.source, file);
      }
      const target = resolve(binding.source, file);
      if (!target) return;
      let name = binding.imported;
      const parent = reference?.ancestors.at(-1);
      if (
        name === "*" &&
        parent?.type === "MemberExpression" &&
        !parent.computed &&
        parent.object === reference!.node
      ) {
        name = parent.property.name;
      }
      work.push({ file: target, name, origin });
    };

    // Keeps the statement that declares `local`, and the statements that it
    // needs, in a declaration module or a stripped module.
    const keep = (
      file: string,
      state: Pick<StripState, "owners" | "statements" | "imports">,
      local: string,
      origin: Origin,
    ) => {
      const analysis = analysisOf(file)!;
      if (analysis.table.imports.has(local)) {
        state.imports.add(local);
        useImport(file, local, origin);
        return;
      }
      const start = state.owners.get(local);
      if (!start || state.statements.has(start)) return;
      state.statements.add(start);
      const queue = [start];
      while (queue.length > 0) {
        const statement = queue.pop()!;
        for (const reference of statementReferences(analysis, statement)) {
          const name: string = reference.node.name;
          if (analysis.table.imports.has(name)) {
            state.imports.add(name);
            useImport(file, name, origin, reference);
            continue;
          }
          const owner = state.owners.get(name);
          if (owner && !state.statements.has(owner)) {
            state.statements.add(owner);
            queue.push(owner);
          }
        }
      }
    };

    const visit = (file: string) => {
      if (visited.has(file)) return;
      visited.add(file);
      const analysis = analysisOf(file);
      if (!analysis) return;
      const { table } = analysis;
      const declaration = analysis.declaration;
      if (declaration) {
        const state = {
          owners: ownersOf(analysis),
          statements: new Set<Node>([declaration.statement]),
          imports: new Set<string>(),
        };
        for (const reference of statementReferences(
          analysis,
          declaration.statement,
        )) {
          const { node, ancestors } = reference;
          const binding = table.imports.get(node.name);
          const parent = ancestors.at(-1);
          const member =
            binding?.imported === "*" &&
            parent?.type === "MemberExpression" &&
            !parent.computed &&
            parent.object === node;
          const origin = {
            file,
            name: member ? `${node.name}.${parent.property.name}` : node.name,
            node,
          };
          if (binding) {
            state.imports.add(node.name);
            useImport(file, node.name, origin, reference);
          } else {
            keep(file, state, node.name, origin);
          }
        }
        return;
      }
      // The module runs whole, so each module that it imports runs, and
      // each name that it imports is used.
      for (const statement of table.module.body) {
        if (!statement.source || isTypeOnly(statement)) continue;
        const target = resolve(statement.source.value, file);
        if (target) work.push({ file: target });
      }
      // An import from a module that only another platform provides isn't
      // followed. Node fails on it, and the bundle check names the module.
      for (const [local, binding] of table.imports) {
        if (providerOfModule(binding.source)) continue;
        useImport(file, local, whole(file, local, binding.specifier));
      }
      for (const [name, target] of table.exports) {
        if (!("source" in target)) continue;
        const resolved = resolve(target.source, file);
        if (resolved)
          work.push({
            file: resolved,
            name: target.imported,
            origin: whole(file, name, reexport(analysis, target.source)),
          });
      }
      for (const star of table.stars) {
        const resolved = resolve(star, file);
        if (resolved)
          work.push({
            file: resolved,
            name: "*",
            origin: whole(file, "*", reexport(analysis, star)),
          });
      }
    };

    const demand = (file: string, name: string, origin: Origin) => {
      const analysis = analysisOf(file);
      if (!analysis) return;
      if (!isStripped(file, analysis)) return visit(file);
      let state = strips.get(file);
      if (!state) {
        state = {
          owners: ownersOf(analysis),
          statements: new Set(),
          imports: new Set(),
          exports: new Set(),
          all: false,
          stars: false,
        };
        strips.set(file, state);
      }
      const { table } = analysis;
      if (name === "*") {
        if (state.all) return;
        state.all = true;
        for (const exported of table.exports.keys())
          work.push({ file, name: exported, origin });
        for (const star of table.stars) {
          const resolved = resolve(star, file);
          if (resolved) work.push({ file: resolved, name: "*", origin });
        }
        return;
      }
      if (state.exports.has(name)) return;
      state.exports.add(name);
      const target = table.exports.get(name);
      if (!target) {
        if (name === "default") return;
        state.stars = true;
        for (const star of table.stars) {
          const resolved = resolve(star, file);
          if (resolved) work.push({ file: resolved, name, origin });
        }
        return;
      }
      if (!("source" in target)) {
        keep(file, state, target.local, origin);
        return;
      }
      if (providerOfModule(target.source)) {
        this.#fail(origin, target.source, file);
      }
      const resolved = resolve(target.source, file);
      if (resolved)
        work.push({ file: resolved, name: target.imported, origin });
    };

    for (const root of this.#roots()) visit(root);
    while (work.length > 0) {
      const { file, name, origin } = work.pop()!;
      if (name === undefined) visit(file);
      else demand(file, name, origin!);
    }
    this.#solved = { strips, analyses: used };
    return this.#solved;
  }

  #fail(origin: Origin, source: string, importer: string): never {
    const analyses = this.#analyses;
    const analysis = analyses.fromFile(origin.file)!;
    const { module, imports } = analysis.table;
    const at = `${analyses.show(origin.file)}:${location(module.source, origin.node.start)}`;
    const why =
      importer === origin.file && imports.get(origin.name)?.source === source
        ? `it is imported from ${describeProvided(source)}`
        : `it depends on ${describeProvided(source)}${importer === origin.file ? "" : ` (${analyses.show(importer)} imports it)`}`;
    const move = `the value that you need to a file that doesn't import ${source}.`;
    const declaration = analysis.declaration;
    if (!declaration) {
      throw new Error(
        `${at}: ${origin.name} can't be used at deploy, because ${why}. Move ${move}`,
      );
    }
    const options = declaration.mark.runtime.map(
      (option) => `\`${option}: ${origin.name}\``,
    );
    const fix =
      options.length > 0
        ? `Pass ${origin.name} only as ${options.join(" or ")}, or move ${move}`
        : `Move ${move}`;
    throw new Error(
      `${at}: ${origin.name} can't be used in a ${declaration.name}() call, which runs at deploy, because ${why}. ${fix}`,
    );
  }
}

/**
 * The copy of a runtime module without a declaration that the infra build
 * runs. It keeps what `strip` lists and removes everything else, including
 * side-effect imports and statements with side effects.
 */
export function stripRuntimeForInfra(
  analysis: ModuleAnalysis,
  strip: RuntimeStrip,
): { code: string; map: ReturnType<MagicString["generateMap"]> } {
  const { module } = analysis.table;
  const { source } = module;
  const text = (node: Node) => source.slice(node.start, node.end);
  const exported = (name: string) => strip.all || strip.exports.has(name);
  const s = new MagicString(source);
  for (const statement of module.body) {
    if (isTypeOnly(statement)) continue;
    switch (statement.type) {
      case "ImportDeclaration": {
        const kept = keptImport(statement, strip.imports, source);
        if (kept === undefined) s.remove(statement.start, statement.end);
        else s.overwrite(statement.start, statement.end, kept);
        break;
      }
      case "ExportNamedDeclaration": {
        if (statement.declaration) {
          if (!strip.statements.has(statement))
            s.remove(statement.start, statement.end);
          break;
        }
        const specifiers = statement.specifiers.filter(
          (specifier: Node) =>
            specifier.exportKind === "type" ||
            exported(nameOf(specifier.exported)),
        );
        if (specifiers.length === 0) {
          s.remove(statement.start, statement.end);
        } else if (specifiers.length < statement.specifiers.length) {
          const from = statement.source
            ? ` from ${text(statement.source)}`
            : "";
          s.overwrite(
            statement.start,
            statement.end,
            `export { ${specifiers.map(text).join(", ")} }${from};`,
          );
        }
        break;
      }
      case "ExportAllDeclaration": {
        const used = statement.exported
          ? exported(nameOf(statement.exported))
          : strip.all || strip.stars;
        if (!used) s.remove(statement.start, statement.end);
        break;
      }
      case "ExportDefaultDeclaration":
        if (!exported("default")) s.remove(statement.start, statement.end);
        break;
      default:
        if (!strip.statements.has(statement))
          s.remove(statement.start, statement.end);
    }
  }
  return {
    code: s.toString(),
    map: s.generateMap({
      hires: true,
      source: module.file,
      includeContent: true,
    }),
  };
}
