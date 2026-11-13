import {
  collectResourceGraph,
  type BaseResource,
  type NameScope,
  type ResourceGroup,
} from "@notation/resource";
import { clearSecretTargets } from "src/secrets";
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
  // False for code that does not use config, such as destroy and viz, so
  // that config which fails its checks does not block it.
  opts: { declarationChecks?: boolean } = {},
): Promise<ResourceGraph> {
  const outFilePath = filePaths.dist.infra(entryPoint);

  clearSecretTargets();
  // todo: move into worker thread. this will cause memory leaks
  return collectResourceGraph(
    async () => {
      await import(`${outFilePath}?${Date.now()}`);
    },
    { scope, declarationChecks: opts.declarationChecks },
  );
}
