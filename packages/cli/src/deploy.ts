import {
  createLoggerReconcilerSubscriber,
  createNdjsonEventEmitter,
  deployApp,
} from "@notation/core";
import { randomUUID } from "node:crypto";
import { compile } from "./compile";
import { defaultLogger, type Logger } from "./logger";
import { redirectStdoutToStderr } from "./stdio";
import { runWithCliErrorHandling } from "./run-with-error-handling";

export type DeployCommandOptions = {
  json?: boolean;
  executionId?: string;
  logger?: Logger;
};

export async function deploy(
  entryPoint: string,
  opts: DeployCommandOptions = {},
) {
  const logger = opts.logger ?? defaultLogger;
  const emit = opts.json
    ? createNdjsonEventEmitter(redirectStdoutToStderr().write)
    : createLoggerReconcilerSubscriber({ logger });

  await compile(entryPoint, { logger });
  logger.info(`Deploying ${entryPoint}`);
  const executionId = opts.executionId ?? randomUUID();
  logger.info(`Yieldstar execution ${executionId}`);

  await runWithCliErrorHandling(
    () => deployApp({ entryPoint, emit, executionId }),
    { logger, command: "deploy" },
  );
}
