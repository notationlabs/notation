import type { ModuleAnalysis } from "./analyze";
import { declaredBy, parseModule } from "./ast";
import { readModuleTable, type ModuleTable } from "./marks";
import { platformOf, type PlatformName } from "./platforms";

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
  return valueExportNames(analysis.table).filter((name) => {
    const target = analysis.table.exports.get(name)!;
    return name !== entry && !("local" in target && target.local === binding);
  });
}

/** Returns the sorted export names of a module, excluding type-only exports. */
export function valueExportNames(table: ModuleTable): string[] {
  const types = typeOnlyNames(table);
  return [...table.exports]
    .filter(([, target]) => !("local" in target && types.has(target.local)))
    .map(([name]) => name)
    .sort();
}

/**
 * Returns the identifiers that a module declares or imports only as types,
 * e.g. `Foo` from `interface Foo {}` or `import type { Foo }`. Excludes an
 * identifier that is also a value, e.g. `Foo` from `class Foo {}`.
 */
function typeOnlyNames(table: ModuleTable): Set<string> {
  const types = new Set<string>();
  const values = new Set<string>(table.imports.keys());
  for (const statement of table.module.body) {
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

/** The exports of a bundle's entry, from a static analysis of its source. */
export type BundleExports = {
  /**
   * The value exports, including `default` and the names that the entry
   * re-exports by name. Sorted.
   */
  names: string[];
  /** The sources of the entry's `export * from` statements. */
  stars: string[];
};

/**
 * Reads the exports of a bundle's entry. For workerd, throws for an export
 * whose value workerd can't start, as the build does for a `$worker`.
 * @param file Names the entry in errors. Its extension decides the language.
 */
export function readEntryExports(
  file: string,
  source: string,
  platform: PlatformName,
): BundleExports {
  const table = readModuleTable(parseModule(file, source));
  const names = valueExportNames(table);
  platformOf(platform).checkExports?.(
    table,
    names.filter((name) => name !== "default"),
  );
  return { names, stars: [...table.stars] };
}
