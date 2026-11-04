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
 * compiler lists next to the bundle. A function that has not been bundled
 * reads nothing.
 */
export function readRuntimeReads(fn: RuntimeFunction): string[] | undefined {
  const file = filePaths.dist.reads(fn.bundle);
  if (!existsSync(file)) return undefined;
  const { reads } = JSON.parse(readFileSync(file, "utf8")) as {
    reads: string[];
  };
  return reads;
}
