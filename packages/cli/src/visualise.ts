import {
  createMermaidFlowChart,
  createMermaidLiveUrl,
  getResourceGraph,
} from "@notation/core";
import { compileInfra } from "./compile";
import { defaultLogger, type Logger } from "./logger";

export async function visualise(
  entryPoint: string,
  logger: Logger = defaultLogger,
) {
  await compileInfra(entryPoint);
  await generateGraph(entryPoint, logger);
}

export async function generateGraph(
  entryPoint: string,
  logger: Logger = defaultLogger,
) {
  logger.info(`Generating graph for ${entryPoint}`);

  const graph = await getResourceGraph(entryPoint);
  const chart = createMermaidFlowChart(graph.resourceGroups, graph.resources);
  const chartUrl = createMermaidLiveUrl(chart);

  logger.info("\nGenerated infrastructure chart:\n");
  logger.info(chartUrl);
}
