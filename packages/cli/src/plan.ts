import {
  createLoggerReconcilerSubscriber,
  planApp,
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
  "drift-update": "~",
  "drift-recreate": "±",
  "delete-orphan": "-",
  noop: " ",
};

export async function plan(entryPoint: string, opts: PlanCommandOptions = {}) {
  const logger = opts.logger ?? defaultLogger;
  const emit = createLoggerReconcilerSubscriber({ logger });
  try {
    if (opts.json) {
      let result: Plan;
      const { restore } = redirectStdoutToStderr();
      try {
        await compile(entryPoint, { logger });
        result = await planApp({
          entryPoint,
          emit,
        });
      } finally {
        restore();
      }
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }

    await compile(entryPoint, { logger });
    logger.info(`Planning ${entryPoint}\n`);
    const result = await planApp({
      entryPoint,
      emit,
    });
    printPlanSummary(result, logger);
  } catch (err: any) {
    if (err.name === "CredentialsProviderError") {
      logger.error(
        "\nAWS credentials not found.",
        "\n\nEnsure you have a default profile set up in ~/.aws/credentials.",
        "\n\nIf using another profile run AWS_PROFILE=otherProfile notation plan.\n",
      );
      process.exit(1);
    }
    throw err;
  }
}

function printPlanSummary(result: Plan, logger: Logger) {
  const changedNodes = result.nodes.filter((node) => node.decision !== "noop");

  for (const node of changedNodes) {
    logger.info(
      `${decisionSymbols[node.decision]} ${node.decision} ${node.type} ${node.id}`,
    );
  }

  const count = (decision: PlanNode["decision"]) =>
    result.nodes.filter((node) => node.decision === decision).length;

  const summary = [
    `${count("create")} to create`,
    `${count("update") + count("drift-update")} to update`,
    `${count("drift-recreate")} to recreate`,
    `${count("delete-orphan")} to delete`,
    `${count("noop")} unchanged`,
  ].join(", ");

  logger.info(`${changedNodes.length > 0 ? "\n" : ""}Plan: ${summary}.`);
}
