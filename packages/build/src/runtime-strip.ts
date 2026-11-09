import MagicString from "magic-string";
import {
  freeReferences,
  isFunction,
  leadingJsDoc,
  location,
  unwrap,
  walk,
  type Node,
  type Reference,
} from "./ast";
import type { Declaration, ModuleAnalysis } from "./analyze";
import { paramNames, parseMark, type Mark } from "./marks";
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
 *    arguments. The others become `undefined`. A runtime argument that names
 *    a resource from an infra module becomes an object of the options that
 *    the resource's mark lists as runtime, imported from where infra imports
 *    them: `sqs.bind(orderQueue)` becomes `sqs.bind({ schema: Order })`. A
 *    mark such as `@runtime options.auth` does the same for the `auth`
 *    option of an object literal argument. The call can be a method of the
 *    object that a call returns, such as
 *    `apiGateway.bind(api).defineRoute({ auth })`.
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
  const added: string[] = [];
  for (const property of keptProperties) {
    const free = new Set(
      freeReferences(property.value).map((reference) => reference.node),
    );
    walk(property.value, (node) => {
      if (node.type !== "CallExpression") return;
      const runtimeMark = markOfCallee(node.callee, analysis, analyses);
      if (runtimeMark?.kind !== "runtime") return;
      node.arguments.forEach((argument: Node, position: number) => {
        if (!runtimeMark.positions.includes(position)) {
          removed.add(argument);
          s.overwrite(argument.start, argument.end, "undefined");
          return;
        }
        const options = runtimeMark.options.filter(
          (option) => option.position === position,
        );
        if (options.length === 0) {
          const stub = resourceStub(argument, free, analysis, analyses, added);
          if (stub === undefined) return;
          removed.add(argument);
          s.overwrite(argument.start, argument.end, stub);
          return;
        }
        // An argument that isn't an object literal is kept, and an infra
        // value in it fails as for any other kept value.
        const object = unwrap(argument);
        if (object.type !== "ObjectExpression") return;
        for (const option of options) {
          const property = object.properties.find(
            (p: Node) => p.type === "Property" && keyOf(p) === option.name,
          );
          if (!property) continue;
          const stub = resourceStub(
            property.value,
            free,
            analysis,
            analyses,
            added,
          );
          if (stub === undefined) continue;
          removed.add(property.value);
          if (property.shorthand)
            s.overwrite(
              property.start,
              property.end,
              `${option.name}: ${stub}`,
            );
          else s.overwrite(property.value.start, property.value.end, stub);
        }
      });
    });
  }
  if (added.length > 0) s.prepend(added.join(""));

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

/**
 * The object that replaces a runtime argument which names a resource from an
 * infra module, or `undefined` for any other argument. The argument can be a
 * name, or a member of an object literal or of a namespace import, such as
 * `queues.orders`. Adds an import to `added` for each runtime option of the
 * resource: by absolute path for a project file, and by name for a package.
 * An option can come from a shared module, a package, or a file that no glob
 * matches and that calls no resource function at its top level, as for any
 * other value that the runtime build bundles.
 * A value made by a call to a function that isn't a resource function fails.
 * The value can be a resource that a helper makes, or a plain value such as a
 * schema, and the build can't tell which. A resource whose `@resource` mark
 * lists no runtime options is left as it is, so it gets the error for an
 * infra value. A resource marked `@resource runtime:`, with no options,
 * becomes `{}`.
 */
function resourceStub(
  argument: Node,
  // The identifiers in the option that refer to a binding outside it.
  free: Set<Node>,
  analysis: ModuleAnalysis,
  analyses: ModuleAnalyses,
  added: string[],
): string | undefined {
  const path = memberPath(unwrap(argument));
  // A local binding, such as a parameter, can shadow the import's name.
  if (!path || !free.has(path.root)) return undefined;
  const { file, source } = analysis.table.module;
  const binding = analysis.table.imports.get(path.root.name);
  if (!binding) return undefined;
  const resolved = analyses.marks.resolve(binding.source, file);
  if (!resolved || !analyses.describeInfra(resolved)) return undefined;

  const keys = [...path.keys];
  const exportName = binding.imported === "*" ? keys.shift() : binding.imported;
  if (exportName === undefined) return undefined;
  const start = exportedValue(resolved, exportName, analyses, new Set());
  const found = start && followKeys(start, keys, analyses);
  if (!found) return undefined;
  const call = unwrap(found.value.node);
  if (call.type !== "CallExpression") return undefined;

  const text = source.slice(argument.start, argument.end);
  const owner = analyses.fromFile(found.value.file);
  const mark = owner && markOfCallee(call.callee, owner, analyses);
  // A member of a resource, such as `orderQueue.schema`, is an infra value.
  if (mark?.kind === "resource" && found.rest > 0) return undefined;
  if (!owner || mark?.kind !== "resource") {
    throw new Error(
      `${analyses.show(file)}:${location(source, argument.start)}: the function reads ${text} from ${analyses.show(resolved)}, but ${text} isn't a call to a resource function, so the build can't find its options. If ${text} is a resource, declare it with a call such as \`queue({ id: "orders", schema: Order })\`, as a top-level const or in an object literal. If it is a plain value, such as a schema, move it to a shared module (files.shared).`,
    );
  }
  if (!mark.runtime) return undefined;
  const definitionFile = found.value.file;
  const first = call.arguments[0];
  const config = first ? unwrap(first) : undefined;
  const where = (n: Node) =>
    `${analyses.show(definitionFile)}:${location(owner.table.module.source, n.start)}`;
  const entries: string[] = [];
  for (const option of mark.runtime) {
    if (config?.type !== "ObjectExpression") {
      throw new Error(
        `${where(call)}: ${text} must be declared with an object literal, so the build can find its ${option}, which the function in ${analyses.show(file)} reads.`,
      );
    }
    const property = config.properties.find(
      (p: Node) => p.type === "Property" && keyOf(p) === option,
    );
    if (!property) continue;
    const value = unwrap(property.value);
    const imported =
      value.type === "Identifier"
        ? owner.table.imports.get(value.name)
        : undefined;
    const from =
      imported && imported.imported !== "*"
        ? analyses.marks.resolve(imported.source, definitionFile)
        : undefined;
    const kind = from ? analyses.kindOf(from)?.kind : undefined;
    if (!imported || imported.imported === "*") {
      throw new Error(
        `${where(property)}: the ${option} of ${text} must be a name that ${analyses.show(definitionFile)} imports directly from a shared module (files.shared), such as \`${option}: Order\` with \`import { Order } from "../shared/schema"\`, because the function in ${analyses.show(file)} reads it. The build copies only a named or default import. For a member of a namespace import, or a value such as \`Order.extend(...)\`, export the value from the shared module and import it by name.`,
      );
    }
    if (kind === "infra" || kind === "runtime") {
      throw new Error(
        `${where(property)}: the ${option} of ${text} must be imported from a shared module (files.shared), because the function in ${analyses.show(file)} reads it.`,
      );
    }
    if (!from) {
      throw new Error(
        `${where(property)}: the build can't resolve "${imported.source}", where the ${option} of ${text} is imported from. The function in ${analyses.show(file)} reads it.`,
      );
    }
    const fromCall = analyses.unmatchedResourceCall(from);
    if (fromCall) {
      throw new Error(
        `${where(property)}: the ${option} of ${text} is imported from ${analyses.show(from)}, which calls ${fromCall.name} at its top level, so the function in ${analyses.show(file)} can't load it. Move the ${option} to a shared module (files.shared).`,
      );
    }
    // The import is written in the function's module, so a relative path or
    // a tsconfig alias could resolve to another file there. A package keeps
    // its name, so that the runtime build applies its export conditions.
    const specifier = analyses.files.isPackageFile(from)
      ? imported.source
      : from;
    const alias = `__notation_${option}_${added.length}`;
    added.push(
      `import { ${imported.imported} as ${alias} } from ${JSON.stringify(specifier)};\n`,
    );
    entries.push(`${option}: ${alias}`);
  }
  return entries.length > 0 ? `{ ${entries.join(", ")} }` : "{}";
}

type Located = { file: string; node: Node };

// A name followed by static member keys, such as `queues.orders` or
// `queues["orders"]`.
function memberPath(node: Node): { root: Node; keys: string[] } | undefined {
  const keys: string[] = [];
  while (node.type === "MemberExpression") {
    const property = node.property;
    if (!node.computed && property.type === "Identifier")
      keys.unshift(property.name);
    else if (node.computed && typeof property.value === "string")
      keys.unshift(property.value);
    else return undefined;
    node = unwrap(node.object);
  }
  return node.type === "Identifier" ? { root: node, keys } : undefined;
}

function keyOf(property: Node): string | undefined {
  if (!property.computed) return property.key.name ?? property.key.value;
  return typeof property.key.value === "string"
    ? property.key.value
    : undefined;
}

// The expression that an export of a module holds, following re-exports and
// imports.
function exportedValue(
  file: string,
  name: string,
  analyses: ModuleAnalyses,
  seen: Set<string>,
): Located | undefined {
  const table = analyses.marks.table(file);
  if (!table) return undefined;
  const target = table.exports.get(name);
  if (!target) {
    for (const source of table.stars) {
      const resolved = analyses.marks.resolve(source, file);
      const found = resolved && exportedValue(resolved, name, analyses, seen);
      if (found) return found;
    }
    return undefined;
  }
  if ("source" in target) {
    const resolved = analyses.marks.resolve(target.source, file);
    return resolved && target.imported !== "*"
      ? exportedValue(resolved, target.imported, analyses, seen)
      : undefined;
  }
  return localValue(file, target.local, analyses, seen);
}

// The expression that a top-level name of a module holds: the initializer of
// its const, its function declaration, or the export that it imports.
function localValue(
  file: string,
  name: string,
  analyses: ModuleAnalyses,
  seen: Set<string>,
): Located | undefined {
  const key = `${file}#${name}`;
  if (seen.has(key)) return undefined;
  seen.add(key);
  const table = analyses.marks.table(file);
  if (!table) return undefined;
  const binding = table.imports.get(name);
  if (binding) {
    const resolved = analyses.marks.resolve(binding.source, file);
    return resolved && binding.imported !== "*"
      ? exportedValue(resolved, binding.imported, analyses, seen)
      : undefined;
  }
  for (let statement of table.module.body) {
    if (statement.type === "ExportNamedDeclaration" && statement.declaration)
      statement = statement.declaration;
    if (statement.type === "FunctionDeclaration" && statement.id?.name === name)
      return { file, node: statement };
    if (statement.type !== "VariableDeclaration" || statement.kind !== "const")
      continue;
    const declarator = statement.declarations.find(
      (d: Node) => d.id.type === "Identifier" && d.id.name === name,
    );
    if (declarator?.init) return { file, node: declarator.init };
  }
  return undefined;
}

// Follows member keys through object literals and the names that hold them.
// Stops at any other expression, such as a call, and counts the keys left.
function followKeys(
  start: Located,
  keys: string[],
  analyses: ModuleAnalyses,
): { value: Located; rest: number } | undefined {
  let value: Located | undefined = start;
  let index = 0;
  const seen = new Set<string>();
  while (value) {
    const node = unwrap(value.node);
    if (node.type === "Identifier") {
      value = localValue(value.file, node.name, analyses, seen);
      continue;
    }
    if (index === keys.length || node.type !== "ObjectExpression") {
      return { value, rest: keys.length - index };
    }
    const key = keys[index++];
    const property = node.properties.find(
      (p: Node) => p.type === "Property" && keyOf(p) === key,
    );
    if (!property) return undefined;
    value = { file: value.file, node: property.value };
  }
  return undefined;
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

// The mark of the function that a call calls. The callee can be a marked
// function that the module declares or imports, a member of a namespace
// import, a member of an imported object literal, such as `sqs.bind`, or a
// member of the object literal that a call returns, such as
// `apiGateway.bind(api).defineRoute`.
function markOfCallee(
  callee: Node,
  analysis: ModuleAnalysis,
  analyses: ModuleAnalyses,
): Mark | undefined {
  const { marks } = analyses;
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
  const path = memberPath(callee);
  const binding = path && table.imports.get(path.root.name);
  if (binding?.imported === "*" && path!.keys.length === 1) {
    return marks.importMark(file, binding, undefined, path!.keys[0]);
  }
  const member = calleeMember(callee, analysis, analyses);
  return member && memberMark(member.object, member.name, analyses);
}

// The object literal that holds the function a callee names, and the
// function's key in it. For `sqs.bind` it is the object of `sqs`. For
// `apiGateway.bind(api).defineRoute` it is the object that `bind` returns.
function calleeMember(
  callee: Node,
  analysis: ModuleAnalysis,
  analyses: ModuleAnalyses,
): { object: Located; name: string } | undefined {
  const { marks } = analyses;
  const { table } = analysis;
  const file = table.module.file;
  callee = unwrap(callee);
  if (callee.type !== "MemberExpression") return undefined;
  const object = unwrap(callee.object);
  if (object.type === "CallExpression") {
    const name = memberKey(callee);
    const fn = calleeFunction(object.callee, analysis, analyses);
    const returned = fn && returnedObjectLiteral(fn);
    return returned && name !== undefined
      ? { object: returned, name }
      : undefined;
  }
  const path = memberPath(callee);
  if (!path) return undefined;
  const binding = table.imports.get(path.root.name);
  if (!binding) return undefined;
  const keys = [...path.keys];
  const resolved = marks.resolve(binding.source, file);
  const exportName = binding.imported === "*" ? keys.shift() : binding.imported;
  if (!resolved || exportName === undefined) return undefined;
  const name = keys.pop();
  const start = exportedValue(resolved, exportName, analyses, new Set());
  const found = start && followKeys(start, keys, analyses);
  if (!found || found.rest > 0 || name === undefined) return undefined;
  return { object: found.value, name };
}

// The function that a callee names, as a node in the module that declares it.
function calleeFunction(
  callee: Node,
  analysis: ModuleAnalysis,
  analyses: ModuleAnalyses,
): Located | undefined {
  const { marks } = analyses;
  const { table } = analysis;
  const file = table.module.file;
  callee = unwrap(callee);
  if (callee.type === "Identifier") {
    return functionAt(
      localValue(file, callee.name, analyses, new Set()),
      analyses,
    );
  }
  const path = memberPath(callee);
  const binding = path && table.imports.get(path.root.name);
  if (binding?.imported === "*" && path!.keys.length === 1) {
    const resolved = marks.resolve(binding.source, file);
    if (!resolved) return undefined;
    return functionAt(
      exportedValue(resolved, path!.keys[0]!, analyses, new Set()),
      analyses,
    );
  }
  const member = calleeMember(callee, analysis, analyses);
  const node = member && unwrap(member.object.node);
  const property = node?.properties.find(
    (p: Node) => p.type === "Property" && keyOf(p) === member!.name,
  );
  return property
    ? functionAt({ file: member!.object.file, node: property.value }, analyses)
    : undefined;
}

// Follows names to a function.
function functionAt(
  value: Located | undefined,
  analyses: ModuleAnalyses,
): Located | undefined {
  const seen = new Set<string>();
  while (value) {
    const node = unwrap(value.node);
    if (isFunction(node)) return { file: value.file, node };
    if (node.type !== "Identifier") return undefined;
    value = localValue(value.file, node.name, analyses, seen);
  }
  return undefined;
}

// The object literal that a function returns: the body of an arrow function,
// or the argument of a return statement at the top of its body.
function returnedObjectLiteral(fn: Located): Located | undefined {
  const body = fn.node.body;
  if (!body) return undefined;
  if (body.type !== "BlockStatement") {
    const node = unwrap(body);
    return node.type === "ObjectExpression"
      ? { file: fn.file, node }
      : undefined;
  }
  for (const statement of body.body) {
    if (statement.type !== "ReturnStatement" || !statement.argument) continue;
    const node = unwrap(statement.argument);
    if (node.type === "ObjectExpression") return { file: fn.file, node };
  }
  return undefined;
}

function memberKey(member: Node): string | undefined {
  const property = member.property;
  if (!member.computed && property.type === "Identifier") return property.name;
  if (member.computed && typeof property.value === "string")
    return property.value;
  return undefined;
}

// The mark of the function that a member of an object literal holds. The
// mark is on the member, as for a method, or on the function that the member
// names.
function memberMark(
  object: Located,
  name: string,
  analyses: ModuleAnalyses,
): Mark | undefined {
  const node = unwrap(object.node);
  if (node.type !== "ObjectExpression") return undefined;
  const property = node.properties.find(
    (p: Node) => p.type === "Property" && keyOf(p) === name,
  );
  const table = property && analyses.marks.table(object.file);
  if (!table) return undefined;
  const value = unwrap(property.value);
  if (value.type === "Identifier") return table.marks.get(value.name);
  if (!isFunction(value)) return undefined;
  const jsDoc = leadingJsDoc(table.module, property.start);
  return jsDoc ? parseMark(jsDoc, paramNames(value), object.file) : undefined;
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
