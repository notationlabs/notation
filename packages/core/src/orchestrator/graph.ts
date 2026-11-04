import { existsSync, readFileSync } from "node:fs";
import {
  collectResourceGraph,
  type BaseResource,
  type NameScope,
  type ResourceGroup,
  type RuntimeFunction,
} from "@notation/resource";
import { filePaths } from "src/utils/paths";

type ResourceGraph = {
  resourceGroups: ResourceGroup[];
  resources: BaseResource[];
};

/**
 * Evaluates the compiled entry and returns its resources. `scope` is the
 * deployment's app and stage, which go in generated AWS names. Without it,
 * names are not scoped, which only suits a graph that is not deployed.
 */
export async function getResourceGraph(
  entryPoint: string,
  scope?: NameScope,
  opts: {
    // False for code that does not use config, such as destroy and viz, so
    // that config which fails its checks does not block it.
    declarationChecks?: boolean;
    // True for plan and deploy, which give each function the values that
    // its bundle reads from infra.
    runtimeReads?: boolean;
  } = {},
): Promise<ResourceGraph> {
  const outFilePath = filePaths.dist.infra(entryPoint);

  // todo: move into worker thread. this will cause memory leaks
  return collectResourceGraph(
    async () => {
      await import(`${outFilePath}?${Date.now()}`);
    },
    {
      scope,
      declarationChecks: opts.declarationChecks,
      runtimeReads: opts.runtimeReads ? readRuntimeReads : undefined,
    },
  );
}

/**
 * The output keys that a function's bundle reads from infra, which the
 * compiler lists next to the bundle. It throws if the list is missing.
 * Reading nothing in that case would deploy a function that fails at its
 * first read.
 */
export function readRuntimeReads(fn: RuntimeFunction): string[] {
  const file = filePaths.dist.reads(fn.bundle);
  if (!existsSync(file)) {
    throw new Error(
      `The function "${fn.id}" has no list of the values it reads from infra at ${file}. The compiler writes it next to the function's bundle. Compile the app again.`,
    );
  }
  const { reads } = JSON.parse(readFileSync(file, "utf8")) as {
    reads: string[];
  };
  return reads;
}
