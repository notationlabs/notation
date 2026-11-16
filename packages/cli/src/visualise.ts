import {
  createMermaidFlowChart,
  createMermaidLiveUrl,
  getResourceGraph,
  type Deployment,
} from "@notation/core";
import { ModuleAnalyses } from "@notation/build";
import { compileInfra } from "./compile";
import { defaultLogger, type Logger } from "./logger";

export async function visualise(
  deployment: Deployment,
  logger: Logger = defaultLogger,
) {
  const { entryPoint, files } = deployment;
  await compileInfra(entryPoint, { analyses: new ModuleAnalyses({ files }) });
  await generateGraph(deployment, logger);
}

/**
 * Evaluates the infra for the deployment's app and stage, as deploy does,
 * so that `deployment()` returns them.
 */
export async function generateGraph(
  { entryPoint, app, stage }: Deployment,
  logger: Logger = defaultLogger,
) {
  logger.info(`Generating graph for ${entryPoint}`);

  const graph = await getResourceGraph(
    entryPoint,
    { app, stage },
    { declarationChecks: false },
  );
  const chart = createMermaidFlowChart(graph.resourceGroups, graph.resources);
  const chartUrl = createMermaidLiveUrl(chart);

  logger.info("\nGenerated infrastructure chart:\n");
  logger.info(chartUrl);
}
