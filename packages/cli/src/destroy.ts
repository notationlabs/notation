import {
  createLoggerReconcilerSubscriber,
  createNdjsonEventEmitter,
  destroyApp,
} from "@notation/core";
import { compile } from "./compile";
import { defaultLogger, type Logger } from "./logger";
import { redirectStdoutToStderr } from "./stdio";

export type DestroyCommandOptions = {
  json?: boolean;
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
  await destroyApp(entryPoint, undefined, undefined, emit);
}
