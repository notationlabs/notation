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

  await compile(deployment.entryPoint, { logger });
  logger.info(`Destroying ${resolveDeploymentId(deployment)}\n`);
  const executionId = opts.executionId ?? randomUUID();
  logger.info(`Execution ID ${executionId}`);

  await destroyApp({ deployment, emit, executionId });
}
