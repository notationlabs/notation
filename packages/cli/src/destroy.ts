import {
  createLoggerReconcilerSubscriber,
  createNdjsonEventEmitter,
  destroyApp,
  resolveDeploymentId,
  type Deployment,
} from "@notation/core";
import { randomUUID } from "node:crypto";
import { compile } from "./compile";
import { defaultLogger, type Logger } from "./logger";
import { redirectStdoutToStderr } from "./stdio";

export type DestroyCommandOptions = {
  json?: boolean;
  executionId?: string;
  // Printed with the execution ID, such as `notation deploy`.
  resumeCommand?: string;
  logger?: Logger;
};

export async function destroy(
  deployment: Deployment,
  opts: DestroyCommandOptions = {},
) {
  const logger = opts.logger ?? defaultLogger;
  const emit = opts.json
    ? createNdjsonEventEmitter(redirectStdoutToStderr().write)
    : createLoggerReconcilerSubscriber({ logger });

  await compile(deployment, { logger });
  logger.info(`Destroying ${resolveDeploymentId(deployment)}\n`);
  const executionId = opts.executionId ?? randomUUID();
  logger.info(`Execution ID ${executionId}`);
  if (opts.resumeCommand) {
    logger.info(
      `To resume after a crash, run ${opts.resumeCommand} --execution-id ${executionId}`,
    );
  }

  await destroyApp({ deployment, emit, executionId });
}
