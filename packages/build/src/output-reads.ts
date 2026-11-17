import type { Declaration } from "./analyze";
import { location, unwrap, type Node } from "./ast";
import type { ModuleAnalyses } from "./modules";
import { exportedValue, localValue, memberPath } from "./runtime-strip";

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
    for (const { node, ancestors } of analysis.references) {
      // The runtime strip removes or checks the declaration's own options.
      if (
        declaration &&
        node.start >= declaration.call.start &&
        node.end <= declaration.call.end
      )
        continue;
      const path = memberPath(outermostMember(node, ancestors));
      if (!path) continue;
      // A namespace import takes the export's name from the first key.
      const binding = table.imports.get(node.name);
      const namespace = binding?.imported === "*";
      const resolved =
        namespace && analyses.marks.resolve(binding.source, file);
      const value = !namespace
        ? localValue(file, node.name, analyses, new Set())
        : resolved && path.keys[0] !== undefined
          ? exportedValue(resolved, path.keys[0], analyses, new Set())
          : undefined;
      const consumed = namespace ? 1 : 0;
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

/** The message for a read of an output, at build or when the code runs. */
export function describeOutputRead({ at, read, declaration }: OutputRead) {
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
