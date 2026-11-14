import {
  createLoggerReconcilerSubscriber,
  createNdjsonEventEmitter,
  deployApp,
  resolveDeploymentId,
  type Deployment,
  type SecretPrompt,
} from "@notation/core";
import { randomUUID } from "node:crypto";
import { compile } from "./compile";
import { defaultLogger, type Logger } from "./logger";
import { canPrompt, terminalSecretPrompt } from "./prompt";
import { redirectStdoutToStderr } from "./stdio";

export type DeployCommandOptions = {
  json?: boolean;
  executionId?: string;
  // Printed with the execution ID, such as `notation deploy`.
  resumeCommand?: string;
  // Off when the caller (e.g. watch) has already compiled.
  compile?: boolean;
  driftDetection?: boolean;
  logger?: Logger;
  /**
   * Asks on the terminal for secret values even with `json`. `watch` sets it
   * for the deploys it runs, whose stdout carries events to `watch`.
   */
  promptSecrets?: boolean;
  /** Defaults to the prompt that `secretPrompt` picks. */
  promptSecret?: SecretPrompt;
};

export async function deploy(
  deployment: Deployment,
  opts: DeployCommandOptions = {},
) {
  const logger = opts.logger ?? defaultLogger;
  const emit = opts.json
    ? createNdjsonEventEmitter(redirectStdoutToStderr().write)
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

  await deployApp({
    deployment,
    emit,
    executionId,
    driftDetection: opts.driftDetection,
    promptSecret:
      opts.promptSecret ??
      secretPrompt({ json: opts.json, promptSecrets: opts.promptSecrets }),
  });
}

/**
 * How deploy asks for the value of a secret without a source: on the
 * terminal, with the question on stderr. There is no prompt without a
 * terminal, or with `--json` unless `promptSecrets` is set, so deploy fails
 * with the command that sets the secret.
 */
export function secretPrompt(opts: {
  json?: boolean;
  promptSecrets?: boolean;
}): SecretPrompt | undefined {
  if (opts.json && !opts.promptSecrets) return undefined;
  if (!canPrompt()) return undefined;
  return terminalSecretPrompt();
}
