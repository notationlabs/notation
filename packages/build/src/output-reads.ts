import type { Declaration, ModuleAnalysis } from "./analyze";
import { location, unwrap, type Node } from "./ast";
import type { ModuleAnalyses } from "./modules";

/** A declaration whose mark lists outputs, and the module that holds it. */
type Found = { declaration: Declaration; file: string };

export type OutputRead = {
  /** Where the code reads the output, as `file:line`. */
  at: string;
  /** The read as written, such as `api.url`. */
  read: string;
  found: Found;
};

/**
 * The first read, in the rendered project modules of a chunk, of an output
 * that a declaration's mark lists, such as `api.url` for a `$worker`. The
 * value is followed through imports, re-exports, namespace members and
 * top-level `const` aliases to the module that declares it.
 */
export function findOutputRead(
  modules: Record<string, { renderedLength: number }>,
  analyses: ModuleAnalyses,
): OutputRead | undefined {
  for (const [file, rendered] of Object.entries(modules)) {
    if (rendered.renderedLength === 0) continue;
    const analysis = analyses.fromFile(file);
    if (!analysis) continue;
    const read = readInModule(file, analysis, analyses);
    if (read) return read;
  }
  return undefined;
}

/** The message for a read of an output, at build or when the code runs. */
export function describeOutputRead({ at, read, found }: OutputRead): string {
  const { declaration } = found;
  const id = declaration.properties.get("id");
  const value = id && unwrap(id.value);
  const declared =
    value?.type === "Literal" && typeof value.value === "string"
      ? `${declaration.name}({ id: ${JSON.stringify(value.value)} })`
      : `${declaration.name}()`;
  const [code, target] =
    declaration.mark.platform === "workerd"
      ? ["Worker code", "Worker"]
      : ["function code", "function"];
  return `${at} reads ${read}, an output of ${declared}. An output is known only at deploy, so ${code} can't read it. Bind it to the ${target} that needs it, and read it from env.`;
}

function readInModule(
  file: string,
  analysis: ModuleAnalysis,
  analyses: ModuleAnalyses,
): OutputRead | undefined {
  const { table, declaration } = analysis;
  for (const { node, ancestors } of analysis.references) {
    // The runtime strip removes or checks the declaration's own options.
    if (
      declaration &&
      node.start >= declaration.call.start &&
      node.end <= declaration.call.end
    )
      continue;
    const chain = [...ancestors, node];
    let index = chain.length - 1;
    let written = node.name as string;
    const binding = table.imports.get(node.name);
    let found: Found | undefined;
    if (binding?.imported === "*") {
      const parent = chain[index - 1];
      const member = parent && memberKey(parent, node);
      if (member === undefined) continue;
      const resolved = analyses.marks.resolve(binding.source, file);
      found = resolved
        ? exportedDeclaration(analyses, resolved, member, new Set())
        : undefined;
      index--;
      written = `${written}.${member}`;
    }
    const keys = readKeys(chain, index);
    if (keys.length === 0) continue;
    found ??=
      binding?.imported === "*"
        ? undefined
        : localDeclaration(analyses, file, analysis, node.name, new Set());
    if (!found) continue;
    const outputs = found.declaration.mark.outputs!;
    const key = keys.find((name) => outputs.includes(name));
    if (key === undefined) continue;
    const line = location(table.module.source, node.start).split(":")[0];
    return {
      at: `${analyses.show(file)}:${line}`,
      read: `${written}.${key}`,
      found,
    };
  }
  return undefined;
}

// The key of a member expression whose object is `object`, when the key is
// a name or a string literal.
function memberKey(holder: Node, object: Node): string | undefined {
  if (holder.type !== "MemberExpression" || holder.object !== object) {
    return undefined;
  }
  if (!holder.computed) return holder.property.name;
  const { property } = holder;
  return property.type === "Literal" && typeof property.value === "string"
    ? property.value
    : undefined;
}

// The properties that the code reads from the expression at `chain[index]`:
// the key of a member expression, or the keys of an object pattern that it
// initialises.
function readKeys(chain: Node[], index: number): string[] {
  const expression = chain[index]!;
  let child = expression;
  let at = index - 1;
  while (at >= 0 && unwrap(chain[at]!) === expression) child = chain[at--]!;
  const holder = chain[at];
  if (!holder) return [];
  const key = memberKey(holder, child);
  if (key !== undefined) return [key];
  if (
    holder.type === "VariableDeclarator" &&
    holder.init === child &&
    holder.id.type === "ObjectPattern"
  ) {
    return holder.id.properties.flatMap((property: Node) => {
      if (property.type !== "Property") return [];
      const name = property.computed ? undefined : property.key;
      if (name?.type === "Identifier") return [name.name];
      return name?.type === "Literal" ? [String(name.value)] : [];
    });
  }
  return [];
}

// The declaration that a local name of a module holds: the module's own
// declaration, an import of one, or a top-level `const` that aliases one.
function localDeclaration(
  analyses: ModuleAnalyses,
  file: string,
  analysis: ModuleAnalysis,
  name: string,
  seen: Set<string>,
): Found | undefined {
  const key = `${file}@${name}`;
  if (seen.has(key)) return undefined;
  seen.add(key);
  const { declaration, table } = analysis;
  if (declaration?.binding === name) {
    return declaration.mark.outputs?.length ? { declaration, file } : undefined;
  }
  const binding = table.imports.get(name);
  if (binding) {
    if (binding.imported === "*") return undefined;
    const resolved = analyses.marks.resolve(binding.source, file);
    return resolved
      ? exportedDeclaration(analyses, resolved, binding.imported, seen)
      : undefined;
  }
  const init = constInit(table.module.body, name);
  if (!init) return undefined;
  const value = unwrap(init);
  if (value.type === "Identifier") {
    return localDeclaration(analyses, file, analysis, value.name, seen);
  }
  if (value.type === "MemberExpression") {
    const object = unwrap(value.object);
    const namespace =
      object.type === "Identifier" ? table.imports.get(object.name) : undefined;
    const member = memberKey(value, value.object);
    if (namespace?.imported !== "*" || member === undefined) return undefined;
    const resolved = analyses.marks.resolve(namespace.source, file);
    return resolved
      ? exportedDeclaration(analyses, resolved, member, seen)
      : undefined;
  }
  return undefined;
}

// The declaration that a module exports under `name`, through re-exports
// and `export * from`.
function exportedDeclaration(
  analyses: ModuleAnalyses,
  file: string,
  name: string,
  seen: Set<string>,
): Found | undefined {
  const key = `${file}#${name}`;
  if (seen.has(key)) return undefined;
  seen.add(key);
  const analysis = analyses.fromFile(file);
  if (!analysis) return undefined;
  const { table } = analysis;
  const target = table.exports.get(name);
  if (target && "local" in target) {
    return localDeclaration(analyses, file, analysis, target.local, seen);
  }
  if (target) {
    if (target.imported === "*") return undefined;
    const resolved = analyses.marks.resolve(target.source, file);
    return resolved
      ? exportedDeclaration(analyses, resolved, target.imported, seen)
      : undefined;
  }
  if (name === "default") return undefined;
  for (const source of table.stars) {
    const resolved = analyses.marks.resolve(source, file);
    const found =
      resolved && exportedDeclaration(analyses, resolved, name, seen);
    if (found) return found;
  }
  return undefined;
}

// The initialiser of a top-level `const name = ...`.
function constInit(body: Node[], name: string): Node | undefined {
  for (const statement of body) {
    const node =
      statement.type === "ExportNamedDeclaration"
        ? statement.declaration
        : statement;
    if (node?.type !== "VariableDeclaration" || node.kind !== "const") continue;
    for (const declarator of node.declarations) {
      if (declarator.id.type === "Identifier" && declarator.id.name === name) {
        return declarator.init ?? undefined;
      }
    }
  }
  return undefined;
}
