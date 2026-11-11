import type { ModuleAnalysis } from "./analyze";
import { declaredBy } from "./ast";
import { platformOf } from "./platforms";

/**
 * Lists the names that a function's bundle exports: the handler, and the
 * names from `otherExports` if the platform needs them. Undefined for a
 * module that deploys no function.
 */
export function runtimeExports(
  analysis: ModuleAnalysis,
): { entry: string; others: string[] } | undefined {
  const entry = analysis.declaration?.mark.entry;
  if (!entry) return undefined;
  return { entry, others: otherExports(analysis) ?? [] };
}

/**
 * Returns a list of export names, excluding:
 * - the infra declaration, e.g. `export const lambda = $lambda(...)`
 * - exports that satisfy the runtime platform's contract, e.g. `handler`
 *   for AWS Lambda and `default` for a Cloudflare Worker
 *
 * Returns undefined for platforms that only need contract exports.
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

// Local names that are only types. A name that also has a value, such as an
// interface merged with a class, is not included.
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
