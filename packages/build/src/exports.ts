import type { ModuleAnalysis } from "./analyze";
import { declaredBy, isTypeOnly, type Node } from "./ast";
import type { ModuleAnalyses } from "./modules";
import { platformOf } from "./platforms";

/**
 * The exports that the runtime entry of a declaration module re-exports:
 * the declaration's entry, and the module's `otherExports`. Empty when the
 * declaration has no entry.
 */
export function runtimeExports(analysis: ModuleAnalysis): string[] {
  const entry = analysis.declaration?.mark.entry;
  if (!entry) return [];
  return [entry, ...(otherExports(analysis) ?? [])];
}

/**
 * The value exports of a declaration module, besides the entry and the
 * declaration, that the runtime entry re-exports because the platform reads
 * them. Undefined when the declaration has no entry, or the platform only
 * reads the entry. Names from `export * from` are missing, as the module's
 * table doesn't hold them.
 */
export function otherExports(analysis: ModuleAnalysis): string[] | undefined {
  const declaration = analysis.declaration;
  const entry = declaration?.mark.entry;
  if (!entry || platformOf(declaration.mark.platform).reexports !== "module") {
    return undefined;
  }
  const { binding } = declaration;
  const types = typeOnlyNames(analysis);
  return [...analysis.table.exports]
    .filter(
      ([name, target]) =>
        name !== entry &&
        !(
          "local" in target &&
          (target.local === binding || types.has(target.local))
        ),
    )
    .map(([name]) => name)
    .sort();
}

/**
 * Fails if one of `names`, which the runtime entry re-exports, is a
 * re-export of a name that is only a type in its module. Rolldown would
 * report a missing export in the generated entry, which doesn't say that
 * the name is only a type.
 */
export function checkTypeReexports(
  analysis: ModuleAnalysis,
  names: string[],
  analyses: ModuleAnalyses,
) {
  const file = analysis.table.module.file;
  for (const name of names) {
    const target = analysis.table.exports.get(name);
    if (!target || !("source" in target) || target.imported === "*") continue;
    const origin = typeOrigin(
      target.source,
      target.imported,
      file,
      analyses,
      new Set(),
    );
    if (!origin) continue;
    throw new Error(
      `${analyses.show(file)} exports ${name} from ${JSON.stringify(target.source)}, and ${name} is only a type in ${analyses.show(origin)}. The runtime bundle re-exports the module's value exports, so write \`export type { ${name} }\`.`,
    );
  }
}

// The file that declares `name` as only a type. Follows re-exports, but not
// `export * from`.
function typeOrigin(
  source: string,
  name: string,
  importer: string,
  analyses: ModuleAnalyses,
  seen: Set<string>,
): string | undefined {
  const file = analyses.marks.resolve(source, importer);
  if (!file || seen.has(file)) return undefined;
  seen.add(file);
  const analysis = analyses.fromFile(file);
  if (!analysis) return undefined;
  const target = analysis.table.exports.get(name);
  // The table leaves out type exports, such as `export interface Env`.
  if (!target) return typeOnlyNames(analysis).has(name) ? file : undefined;
  if ("local" in target) {
    return typeOnlyNames(analysis).has(target.local) ? file : undefined;
  }
  if (target.imported === "*") return undefined;
  return typeOrigin(target.source, target.imported, file, analyses, seen);
}

// The local names of a module that only name a type: interfaces, type
// aliases, `declare` statements, namespaces that hold only types, and type
// imports. `export { Local }` of such a name has no value to re-export. A
// name that also has a value, such as an interface merged with a class, is
// left out.
function typeOnlyNames(analysis: ModuleAnalysis): Set<string> {
  const types = new Set<string>();
  const values = new Set<string>(analysis.table.imports.keys());
  for (const statement of analysis.table.module.body) {
    const node =
      statement.type === "ExportNamedDeclaration" && statement.declaration
        ? statement.declaration
        : statement;
    if (node.type === "ImportDeclaration") {
      for (const specifier of node.specifiers) {
        if (node.importKind === "type" || specifier.importKind === "type")
          types.add(specifier.local.name);
      }
    } else if (
      node.type === "TSInterfaceDeclaration" ||
      node.type === "TSTypeAliasDeclaration" ||
      (node.type === "TSModuleDeclaration" && holdsOnlyTypes(node))
    ) {
      types.add(node.id.name);
    } else {
      for (const name of declaredBy(node)) {
        (node.declare ? types : values).add(name);
      }
    }
  }
  for (const name of values) types.delete(name);
  return types;
}

function holdsOnlyTypes(namespace: Node): boolean {
  const body = namespace.body;
  if (!body) return true;
  if (body.type === "TSModuleDeclaration") return holdsOnlyTypes(body);
  return body.body.every((statement: Node) => {
    const node =
      statement.type === "ExportNamedDeclaration" && statement.declaration
        ? statement.declaration
        : statement;
    return node.type === "TSModuleDeclaration"
      ? holdsOnlyTypes(node)
      : isTypeOnly(statement);
  });
}
