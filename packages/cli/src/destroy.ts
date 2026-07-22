import {
  createLoggerReconcilerSubscriber,
  createNdjsonEventEmitter,
  destroyApp,
} from "@notation/core";
import { randomUUID } from "node:crypto";
import { compile } from "./compile";
import { defaultLogger, type Logger } from "./logger";
import { redirectStdoutToStderr } from "./stdio";
import { runWithCliErrorHandling } from "./run-with-error-handling";

export type DestroyCommandOptions = {
  json?: boolean;
  executionId?: string;
  logger?: Logger;
};

export async function destroy(
  entryPoint: string,
  opts: DestroyCommandOptions = {},
) {
  const logger = opts.logger ?? defaultLogger;
  const emit = opts.json
    ? createNdjsonEventEmitter(redirectStdoutToStderr().write)
    : createLoggerReconcilerSubscriber({ logger });

  await compile(entryPoint, { logger });
  logger.info(`Destroying ${entryPoint}\n`);
  const executionId = opts.executionId ?? randomUUID();
  logger.info(`Yieldstar execution ${executionId}`);

  await runWithCliErrorHandling(
    () => destroyApp({ entryPoint, emit, executionId }),
    { logger, command: "destroy" },
  );
}
