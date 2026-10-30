import {
  createLoggerReconcilerSubscriber,
  planApp,
  resolveDeploymentId,
  type Deployment,
  type Project,
  type Plan,
  type PlanNode,
} from "@notation/core";
import { compile } from "./compile";
import { defaultLogger, type Logger } from "./logger";
import { redirectStdoutToStderr } from "./stdio";

export type PlanCommandOptions = {
  json?: boolean;
  logger?: Logger;
};

const decisionSymbols: Record<PlanNode["decision"], string> = {
  create: "+",
  update: "~",
  replace: "-/+",
  "drift-update": "~",
  "drift-replace": "-/+",
  "drift-recreate": "±",
  "delete-orphan": "-",
  noop: " ",
};

export async function plan(
  project: Project,
  deployment: Deployment,
  opts: PlanCommandOptions = {},
) {
  const logger = opts.logger ?? defaultLogger;
  const emit = createLoggerReconcilerSubscriber({ logger });
  if (opts.json) {
    let result: Plan;
    const { restore } = redirectStdoutToStderr();
    try {
      await compile(project, deployment.entryPoint, { logger });
      result = await planApp({ deployment, emit });
    } finally {
      restore();
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  await compile(project, deployment.entryPoint, { logger });
  logger.info(`Planning ${resolveDeploymentId(deployment)}\n`);
  const result = await planApp({ deployment, emit });
  printPlanSummary(result, logger);
}

function printPlanSummary(result: Plan, logger: Logger) {
  const changedNodes = result.nodes.filter((node) => node.decision !== "noop");

  for (const node of changedNodes) {
    logger.info(
      `${decisionSymbols[node.decision]} ${node.decision} ${node.type} ${node.id}`,
    );
    for (const field of node.replaceFields ?? []) {
      logger.info(
        field.known
          ? `    ${field.name} forces replacement`
          : `    ${field.name} unknown, may force replacement`,
      );
    }
  }

  const count = (decision: PlanNode["decision"]) =>
    result.nodes.filter((node) => node.decision === decision).length;

  const summary = [
    `${count("create")} to create`,
    `${count("update") + count("drift-update")} to update`,
    `${count("replace") + count("drift-replace")} to replace`,
    `${count("drift-recreate")} to recreate`,
    `${count("delete-orphan")} to delete`,
    `${count("noop")} unchanged`,
  ].join(", ");

  logger.info(`${changedNodes.length > 0 ? "\n" : ""}Plan: ${summary}.`);
}
