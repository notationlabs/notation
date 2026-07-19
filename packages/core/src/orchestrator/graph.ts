import path from "path";
import {
  collectResourceGraph,
  type BaseResource,
  type ResourceGroup,
} from "@notation/resource";
import { filePaths } from "src/utils/paths";

type ResourceGraph = {
  resourceGroups: ResourceGroup[];
  resources: BaseResource[];
};

export async function getResourceGraph(
  entryPoint: string,
): Promise<ResourceGraph> {
  const outFilePath = filePaths.dist.infra(entryPoint);

  // todo: move into worker thread. this will cause memory leaks
  return collectResourceGraph(async () => {
    await import(path.join(process.cwd(), `${outFilePath}?${Date.now()}`));
  });
}
