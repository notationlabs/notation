import {
  createMermaidFlowChart,
  createMermaidLiveUrl,
  getResourceGraph,
  type Build,
} from "@notation/core";
import { ModuleAnalyses } from "@notation/build";
import { compileInfra } from "./compile";
import { defaultLogger, type Logger } from "./logger";

export async function visualise(
  { entryPoint, runtimeModules, sharedModules }: Build,
  logger: Logger = defaultLogger,
) {
  await compileInfra(entryPoint, {
    runtimeModules,
    analyses: new ModuleAnalyses({ sharedModules }),
  });
  await generateGraph(entryPoint, logger);
}

export async function generateGraph(
  entryPoint: string,
  logger: Logger = defaultLogger,
) {
  logger.info(`Generating graph for ${entryPoint}`);

  const graph = await getResourceGraph(entryPoint, undefined, {
    declarationChecks: false,
  });
  const chart = createMermaidFlowChart(graph.resourceGroups, graph.resources);
  const chartUrl = createMermaidLiveUrl(chart);

  logger.info("\nGenerated infrastructure chart:\n");
  logger.info(chartUrl);
}
