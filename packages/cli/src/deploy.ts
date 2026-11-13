import {
  createLoggerReconcilerSubscriber,
  deployApp,
  resolveDeploymentId,
  runWithSecretPromptHandler,
  type Deployment,
  type SecretPromptHandler,
} from "@notation/core";
import { randomUUID } from "node:crypto";
import { compile } from "./compile";
import { createScrubbedLogger, defaultLogger, type Logger } from "./logger";
import {
  INTERACTIVE_SECRET_PROMPT_ENV,
  createSecretPromptHandler,
  isTtyPromptAvailable,
  type SecretPromptIo,
} from "./secret-prompt";
import { createScrubbedNdjsonEmitter, redirectStdoutToStderr } from "./stdio";

export type DeployCommandOptions = {
  json?: boolean;
  executionId?: string;
  // Printed with the execution ID, such as `notation deploy`.
  resumeCommand?: string;
  // Off when the caller (e.g. watch) has already compiled.
  compile?: boolean;
  driftDetection?: boolean;
  logger?: Logger;
  promptHandler?: SecretPromptHandler;
  io?: SecretPromptIo;
};

export async function deploy(
  deployment: Deployment,
  opts: DeployCommandOptions = {},
) {
  const logger = createScrubbedLogger(opts.logger ?? defaultLogger);
  const redirect = opts.json ? redirectStdoutToStderr() : undefined;

  try {
    const emit = redirect
      ? createScrubbedNdjsonEmitter(redirect.write)
      : createLoggerReconcilerSubscriber({ logger });

    if (opts.compile !== false) {
      await compile(deployment, { logger });
    }
    logger.info(`Deploying ${resolveDeploymentId(deployment)}`);
    const executionId = opts.executionId ?? randomUUID();
    logger.info(`Execution ID ${executionId}`);
    if (opts.resumeCommand) {
      logger.info(
        `To resume after a crash, run ${opts.resumeCommand} --execution-id ${executionId}`,
      );
    }

    const allowInteractivePrompt =
      isTtyPromptAvailable(opts.io) &&
      (!opts.json || process.env[INTERACTIVE_SECRET_PROMPT_ENV] === "1");
    const promptHandler =
      opts.promptHandler ??
      (allowInteractivePrompt ? createSecretPromptHandler(opts.io) : undefined);

    await runWithSecretPromptHandler(promptHandler, () =>
      deployApp({
        deployment,
        emit,
        executionId,
        driftDetection: opts.driftDetection,
      }),
    );
  } finally {
    redirect?.restore();
  }
}
