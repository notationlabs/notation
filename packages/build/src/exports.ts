import type { ModuleAnalysis } from "./analyze";
import { declaredBy } from "./ast";
import { platformOf } from "./platforms";

/**
 * Returns the export names of a function's bundle:
 * - `entry`: the export that satisfies the runtime platform's contract
 * - `others`: the export names from `otherExports`
 *
 * Returns undefined for modules that deploy no function.
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

// Returns the identifiers that a module declares or imports only as types,
// e.g. `Foo` from `interface Foo {}` or `import type { Foo }`. Excludes an
// identifier that is also a value, e.g. `Foo` from `class Foo {}`.
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
