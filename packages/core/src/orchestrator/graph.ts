import {
  collectResourceGraph,
  getActiveResourceCollection,
  type BaseResource,
  type NameScope,
  type ResourceGroup,
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
  // False for code that does not use config, such as destroy and viz, so
  // that config which fails its checks does not block it.
  opts: { declarationChecks?: boolean } = {},
): Promise<ResourceGraph> {
  const outFilePath = filePaths.dist.infra(entryPoint);

  // todo: move into worker thread. this will cause memory leaks
  return collectResourceGraph(
    async () => {
      await import(`${outFilePath}?${Date.now()}`);
    },
    { scope, declarationChecks: opts.declarationChecks },
  );
}

/**
 * The app and the stage that the infra code is being evaluated for, such as
 * `{ app: "orders", stage: "prod" }`. Use it in a resource's config for a
 * value that depends on the stage. Throws outside the evaluation of infra
 * code.
 */
export function deployment(): { app: string; stage: string } {
  const scope = getActiveResourceCollection()?.scope;
  if (!scope) {
    throw new Error(
      "deployment() can only be called while notation evaluates the infra code, as deploy, plan, destroy and viz do.",
    );
  }
  return { app: scope.app, stage: scope.stage };
}
