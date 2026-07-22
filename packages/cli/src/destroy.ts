import {
  createLoggerReconcilerSubscriber,
  createNdjsonEventEmitter,
  destroyApp,
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
  logger.info(`YieldStar execution ${executionId}`);

  try {
    await destroyApp({ entryPoint, emit, executionId });
  } catch (err: any) {
    if (err.name === "CredentialsProviderError") {
      logger.error(
        "\nAWS credentials not found.",
        "\n\nEnsure you have a default profile set up in ~/.aws/credentials.",
        "\n\nIf using another profile run AWS_PROFILE=otherProfile notation destroy.\n",
      );
      process.exit(1);
    }
    logger.error(err);
    process.exit(1);
  }
}
