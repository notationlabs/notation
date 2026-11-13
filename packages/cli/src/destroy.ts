import {
  createLoggerReconcilerSubscriber,
  destroyApp,
  resolveDeploymentId,
  type Deployment,
} from "@notation/core";
import { randomUUID } from "node:crypto";
import { compile } from "./compile";
import { createScrubbedLogger, defaultLogger, type Logger } from "./logger";
import { createScrubbedNdjsonEmitter, redirectStdoutToStderr } from "./stdio";

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
  const logger = createScrubbedLogger(opts.logger ?? defaultLogger);
  const redirect = opts.json ? redirectStdoutToStderr() : undefined;

  try {
    const emit = redirect
      ? createScrubbedNdjsonEmitter(redirect.write)
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
  } finally {
    redirect?.restore();
  }
}
