import path from "node:path";
import MagicString from "magic-string";
import type { ModuleAnalysis } from "./analyze";
import {
  declaredBy,
  freeReferences,
  isTypeOnly,
  unwrap,
  type Node,
} from "./ast";
import { otherExports } from "./exports";
import type { Marks } from "./marks";
import { platformOf, type PlatformName } from "./platforms";

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

/**
 * A declaration module, as the infra build records it. A declaration whose
 * mark has no `entry`, such as a Durable Object namespace, has no runtime
 * bundle of its own.
 */
export type DeclarationModule = {
  /** The absolute path of the module. */
  path: string;
  /** The local name of the binding that holds the declaration. */
  binding: string;
  /** The export that the platform calls, such as `handler`. */
  entry?: string;
  /** The mark's `platform`. Absent for the default platform, Node. */
  platform?: PlatformName;
};

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
  for (const option of declaration.mark.runtime) {
    const property = declaration.properties.get(option);
    if (property) skip.add(property);
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

// An option whose value is a name that the module declares or imports, such
// as `class: Counter`, becomes a function with that name, so the infra build
// can read `config.class.name` without loading the class. The name is the
// local name at the call site. Any other value, such as a class expression,
// becomes a function whose name is "", so that a provider can reject an
// option that needs a name.
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
