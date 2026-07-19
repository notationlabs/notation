import {
  createLoggerReconcilerSubscriber,
  createNdjsonEventEmitter,
  deployApp,
} from "@notation/core";
import { compile } from "./compile";
import { defaultLogger, type Logger } from "./logger";
import { redirectStdoutToStderr } from "./stdio";

export type DeployCommandOptions = {
  json?: boolean;
  logger?: Logger;
};

export async function deploy(
  entryPoint: string,
  opts: DeployCommandOptions = {},
) {
  const logger = opts.logger ?? defaultLogger;
  // In --json mode console output moves to stderr so stdout carries only the
  // NDJSON event stream; capture the real stdout for the emitter first.
  const emit = opts.json
    ? createNdjsonEventEmitter(redirectStdoutToStderr().write)
    : createLoggerReconcilerSubscriber({ logger });

  await compile(entryPoint, { logger });
  logger.info(`Deploying ${entryPoint}`);

  try {
    await deployApp({
      entryPoint,
      emit,
    });
  } catch (err: any) {
    if (err.name === "CredentialsProviderError") {
      logger.error(
        "\nAWS credentials not found.",
        "\n\nEnsure you have a default profile set up in ~/.aws/credentials.",
        "\n\nIf using another profile run AWS_PROFILE=otherProfile notation deploy.\n",
      );
      process.exit(1);
    }
    logger.error(err);
    process.exit(1);
  }
}
