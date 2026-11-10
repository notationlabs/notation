import type { ModuleAnalysis } from "./analyze";
import { declaredBy } from "./ast";
import { platformOf } from "./platforms";

/**
 * The exports that the runtime entry of a declaration module re-exports:
 * the declaration's entry, and the module's `otherExports`. Undefined when
 * the declaration has no entry.
 */
export function runtimeExports(
  analysis: ModuleAnalysis,
): { entry: string; others: string[] } | undefined {
  const entry = analysis.declaration?.mark.entry;
  if (!entry) return undefined;
  return { entry, others: otherExports(analysis) ?? [] };
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
  if (!entry || !platformOf(declaration.mark.platform).reexportsModule) {
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

// The local names of a module that only name a type: interfaces, type
// aliases, `declare` statements and type imports. `export { Local }` of such
// a name has no value to re-export. A name that also has a value, such as an
// interface merged with a class, is left out.
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
      node.type === "TSTypeAliasDeclaration"
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
