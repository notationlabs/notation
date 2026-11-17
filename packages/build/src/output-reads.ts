import type { Declaration } from "./analyze";
import { location, unwrap, type Node } from "./ast";
import type { ModuleAnalyses } from "./modules";
import type { PlatformName } from "./platforms";
import {
  exportedValue,
  localValue,
  memberPath,
  keptOptions,
} from "./runtime-strip";

export type OutputRead = {
  /** Where the code reads the output, as `file:line`. */
  at: string;
  /** The read as written, such as `api.url`. */
  read: string;
  declaration: Declaration;
};

/**
 * The first read, in the rendered project modules of a chunk, of an output
 * that a declaration's mark lists, such as `api.url` for a `$worker`. The
 * read is `x.url` or `x["url"]`, where `x` is the module's own declaration,
 * a named import of one, or a member of a namespace import.
 */
export function findOutputRead(
  modules: Record<string, { renderedLength: number }>,
  analyses: ModuleAnalyses,
): OutputRead | undefined {
  for (const [file, rendered] of Object.entries(modules)) {
    if (rendered.renderedLength === 0) continue;
    const analysis = analyses.fromFile(file);
    if (!analysis) continue;
    const { table, declaration } = analysis;
    const unchecked = declaration ? strippedOptions(declaration) : [];
    for (const { node, ancestors } of analysis.references) {
      if (
        unchecked.some(
          (option) => node.start >= option.start && node.end <= option.end,
        )
      )
        continue;
      const path = memberPath(outermostMember(node, ancestors));
      if (!path) continue;
      // A namespace import takes the export's name from the first key.
      const binding = table.imports.get(node.name);
      const namespace = binding?.imported === "*";
      const [value, consumed] = namespace
        ? [namespaceValue(file, binding.source, path.keys[0], analyses), 1]
        : [localValue(file, node.name, analyses, new Set()), 0];
      const key = path.keys[consumed];
      const owner = value && analyses.fromFile(value.file)?.declaration;
      if (
        !owner ||
        key === undefined ||
        unwrap(value.node) !== owner.call ||
        !owner.mark.outputs?.includes(key)
      )
        continue;
      const read = [node.name, ...path.keys.slice(0, consumed + 1)].join(".");
      const line = location(table.module.source, node.start).split(":")[0];
      return {
        at: `${analyses.show(file)}:${line}`,
        read,
        declaration: owner,
      };
    }
  }
  return undefined;
}

// The value of an export of the module that a namespace import names.
function namespaceValue(
  file: string,
  source: string,
  name: string | undefined,
  analyses: ModuleAnalyses,
) {
  const resolved = analyses.marks.resolve(source, file);
  return resolved && name !== undefined
    ? exportedValue(resolved, name, analyses, new Set())
    : undefined;
}

// The options of a declaration whose values the runtime build doesn't run:
// those that it removes, and the `keys` options, whose values become
// `undefined`. A read in any other option, such as the `class` of a
// `$durableObject`, runs in the function.
function strippedOptions(declaration: Declaration): Node[] {
  const kept = keptOptions(declaration.mark);
  return [...declaration.properties]
    .filter(([key]) => !kept.has(key) || declaration.mark.keys.includes(key))
    .map(([, property]) => property);
}

// The outermost member expression with static keys that has `node` at its
// root, or `node` itself.
function outermostMember(node: Node, ancestors: Node[]): Node {
  let outer = node;
  for (let index = ancestors.length - 1; index >= 0; index--) {
    const parent = ancestors[index]!;
    if (unwrap(parent) === outer) continue;
    if (
      parent.type !== "MemberExpression" ||
      unwrap(parent.object) !== unwrap(outer) ||
      !memberPath(parent)
    )
      break;
    outer = parent;
  }
  return outer;
}

/**
 * The message for a read of an output, at build or when the code runs.
 * `platform` is the platform of the code that reads the output.
 */
export function describeOutputRead(
  { at, read, declaration }: OutputRead,
  platform: PlatformName,
) {
  const name = declaration.mark.name ?? declaration.name;
  const id = declaration.properties.get("id");
  const value = id && unwrap(id.value);
  const declared =
    value?.type === "Literal" && typeof value.value === "string"
      ? `${name}({ id: ${JSON.stringify(value.value)} })`
      : `${name}()`;
  const [code, target] =
    platform === "workerd"
      ? ["Worker code", "Worker"]
      : ["function code", "function"];
  return `${at} reads ${read}, an output of ${declared}. An output is known only at deploy, so ${code} can't read it. Bind it to the ${target} that needs it, and read it from env.`;
}
