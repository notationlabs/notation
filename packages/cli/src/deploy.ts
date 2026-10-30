import {
  createLoggerReconcilerSubscriber,
  createNdjsonEventEmitter,
  deployApp,
  resolveDeploymentId,
  type Deployment,
  type Project,
} from "@notation/core";
import { randomUUID } from "node:crypto";
import { compile } from "./compile";
import { defaultLogger, type Logger } from "./logger";
import { redirectStdoutToStderr } from "./stdio";

export type DeployCommandOptions = {
  json?: boolean;
  executionId?: string;
  // Off when the caller (e.g. watch) has already compiled.
  compile?: boolean;
  driftDetection?: boolean;
  logger?: Logger;
};

export async function deploy(
  project: Project,
  deployment: Deployment,
  opts: DeployCommandOptions = {},
) {
  const logger = opts.logger ?? defaultLogger;
  const emit = opts.json
    ? createNdjsonEventEmitter(redirectStdoutToStderr().write)
    : createLoggerReconcilerSubscriber({ logger });

  if (opts.compile !== false) {
    await compile(project, deployment.entryPoint, { logger });
  }
  logger.info(`Deploying ${resolveDeploymentId(deployment)}`);
  const executionId = opts.executionId ?? randomUUID();
  logger.info(`Execution ID ${executionId}`);

  await deployApp({
    deployment,
    emit,
    executionId,
    driftDetection: opts.driftDetection,
  });
}
