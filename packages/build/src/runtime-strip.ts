import MagicString from "magic-string";
import {
  freeReferences,
  location,
  unwrap,
  walk,
  type Node,
  type Reference,
} from "./ast";
import type { Declaration, ModuleAnalysis } from "./analyze";
import type { Marks } from "./marks";
import type { ModuleAnalyses } from "./modules";

/**
 * Reduces the declaration of a module to its runtime options, for the runtime
 * build:
 *
 * 1. Options that the mark lists in neither `shared` nor `runtime` are
 *    removed.
 * 2. A `keys` option keeps the keys of the object that it returns, and each
 *    value becomes `undefined`.
 * 3. A call to a function marked `@runtime` keeps only its runtime
 *    arguments. The others become `undefined`.
 * 4. An import whose uses were all removed is removed too, so the bundle
 *    doesn't load the module it imports from. Without this, the module would
 *    still load when `verbatimModuleSyntax` keeps unused imports.
 *
 * The binding and its export stay, so that modules which import it still
 * link. Throws when a kept option refers to an infra module, or to a file
 * that no glob matches and that calls a resource function at its top level,
 * or when a kept option calls a resource function.
 */
export function stripForRuntime(
  analysis: ModuleAnalysis,
  analyses: ModuleAnalyses,
): { code: string; map: ReturnType<MagicString["generateMap"]> } | undefined {
  const declaration = analysis.declaration;
  if (!declaration) return undefined;
  const { marks } = analyses;
  const { module } = analysis.table;
  const { mark } = declaration;
  const s = new MagicString(module.source);
  const keptOptions = new Set([...mark.shared, ...mark.runtime]);
  // Nodes whose values the build removes, so their references don't count.
  const removed = new Set<Node>();

  // Each removed option takes the comma after it, or the last one takes the
  // comma before it. The ranges can overlap, so they are merged first.
  const properties = [...declaration.properties.entries()];
  const ranges: [number, number][] = [];
  properties.forEach(([key, property], index) => {
    if (keptOptions.has(key)) return;
    removed.add(property);
    const next = properties[index + 1]?.[1];
    const lastKept = properties
      .slice(0, index)
      .findLast(([k]) => keptOptions.has(k))?.[1];
    ranges.push(
      next
        ? [property.start, next.start]
        : [lastKept?.end ?? property.start, property.end],
    );
  });
  for (const [start, end] of mergeRanges(ranges)) s.remove(start, end);

  for (const key of mark.keys) {
    const property = declaration.properties.get(key);
    if (!property || !keptOptions.has(key)) continue;
    for (const entry of returnedObject(
      property,
      declaration,
      module.file,
      module.source,
    ).properties) {
      removed.add(entry.value);
      if (entry.shorthand)
        s.overwrite(entry.start, entry.end, `${entry.key.name}: undefined`);
      else s.overwrite(entry.value.start, entry.value.end, "undefined");
    }
  }

  const keptProperties = properties
    .filter(([key]) => keptOptions.has(key))
    .map(([, p]) => p);
  for (const property of keptProperties) {
    walk(property.value, (node) => {
      if (node.type !== "CallExpression") return;
      const runtimeMark = markOfCallee(node.callee, analysis, marks);
      if (runtimeMark?.kind !== "runtime") return;
      node.arguments.forEach((argument: Node, position: number) => {
        if (runtimeMark.positions.includes(position)) return;
        removed.add(argument);
        s.overwrite(argument.start, argument.end, "undefined");
      });
    });
  }

  for (const property of keptProperties) {
    for (const reference of freeReferences(property.value, removed)) {
      checkReference(reference.node, declaration, analysis, analyses);
    }
  }

  removeEmptiedImports(module.body, analysis.references, removed, s);

  return {
    code: s.toString(),
    map: s.generateMap({
      hires: true,
      source: module.file,
      includeContent: true,
    }),
  };
}

// An import is removed when one of its names was used, and none of them is
// used outside the removed nodes. An import that was never used is left, as
// it may be there for the module's side effects.
function removeEmptiedImports(
  body: Node[],
  before: Reference[],
  removed: Set<Node>,
  s: MagicString,
) {
  const used = (references: Reference[]) =>
    new Set(references.map((reference) => reference.node.name));
  const usedBefore = used(before);
  const usedAfter = used(
    body.flatMap((statement) => freeReferences(statement, removed)),
  );
  for (const statement of body) {
    if (statement.type !== "ImportDeclaration") continue;
    const names: string[] = statement.specifiers.map(
      (specifier: Node) => specifier.local.name,
    );
    if (
      names.some((name) => usedBefore.has(name)) &&
      !names.some((name) => usedAfter.has(name))
    ) {
      s.remove(statement.start, statement.end);
    }
  }
}

function mergeRanges(ranges: [number, number][]): [number, number][] {
  const merged: [number, number][] = [];
  for (const [start, end] of [...ranges].sort((a, b) => a[0] - b[0])) {
    const last = merged.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

function markOfCallee(callee: Node, analysis: ModuleAnalysis, marks: Marks) {
  const { table } = analysis;
  const file = table.module.file;
  callee = unwrap(callee);
  if (callee.type === "Identifier") {
    const local = table.marks.get(callee.name);
    if (local) return local;
    const binding = table.imports.get(callee.name);
    return binding && binding.imported !== "*"
      ? marks.importMark(file, binding)
      : undefined;
  }
  if (
    callee.type === "MemberExpression" &&
    !callee.computed &&
    callee.object.type === "Identifier"
  ) {
    const binding = table.imports.get(callee.object.name);
    if (binding?.imported === "*") {
      return marks.importMark(file, binding, undefined, callee.property.name);
    }
  }
  return undefined;
}

function checkReference(
  node: Node,
  declaration: Declaration,
  analysis: ModuleAnalysis,
  analyses: ModuleAnalyses,
) {
  const { marks } = analyses;
  const { table } = analysis;
  const { file, source } = table.module;
  const binding = table.imports.get(node.name);
  if (!binding) return;
  const at = `${analyses.show(file)}:${location(source, node.start)}`;
  const advice =
    "The runtime build removes infra. Read infra values in the function through the declaration's env().";
  const plainValue =
    "Move a plain value that a kept option uses to a shared module (files.shared), or to a file that no glob matches.";
  const resolved = marks.resolve(binding.source, file);
  const infra = resolved && analyses.describeInfra(resolved);
  if (infra) {
    throw new Error(
      `${at}: an option of ${declaration.name} that the function keeps refers to ${node.name}, from ${infra}. ${advice} ${plainValue}`,
    );
  }
  const call = resolved && analyses.unmatchedResourceCall(resolved);
  if (call) {
    const name = analyses.show(resolved);
    throw new Error(
      `${at}: an option of ${declaration.name} that the function keeps refers to ${node.name}, from ${name}. ${name} calls ${call.name} at its top level, so the function can't load it. ${advice} ${plainValue}`,
    );
  }
  const mark =
    binding.imported === "*" ? undefined : marks.importMark(file, binding);
  if (mark?.kind === "resource") {
    throw new Error(
      `${at}: an option of ${declaration.name} that the function keeps uses the resource function ${node.name}. ${advice}`,
    );
  }
}

// The object literal that a `keys` option returns: `() => ({ ... })`, or a
// function whose body is one `return { ... }`.
function returnedObject(
  property: Node,
  declaration: Declaration,
  file: string,
  source: string,
): Node {
  const fail = (): never => {
    throw new Error(
      `${file}:${location(source, property.start)}: the ${property.key.name ?? property.key.value} option of ${declaration.name} must be a function that returns an object literal, such as \`() => ({ NAME: value })\`, with no spread or computed keys, so the build can read its names.`,
    );
  };
  if (property.shorthand) return fail();
  const fn = unwrap(property.value);
  if (fn.type !== "ArrowFunctionExpression" && fn.type !== "FunctionExpression")
    return fail();
  let body = fn.body;
  if (body.type === "BlockStatement") {
    const [statement] = body.body;
    if (
      body.body.length !== 1 ||
      statement.type !== "ReturnStatement" ||
      !statement.argument
    )
      return fail();
    body = statement.argument;
  }
  const object = unwrap(body);
  if (object.type !== "ObjectExpression") return fail();
  for (const entry of object.properties) {
    if (
      entry.type !== "Property" ||
      entry.computed ||
      entry.kind !== "init" ||
      entry.method
    )
      return fail();
  }
  return object;
}
