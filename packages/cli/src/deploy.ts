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
import { parentSecretPrompt } from "./deploy-child";
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
    promptSecret: opts.promptSecret ?? secretPrompt({ json: opts.json }),
  });
}

/**
 * How deploy asks for the value of a secret without a source: through the
 * parent process when `watch` started it, and otherwise on the terminal.
 * There is no prompt with `--json`, whose stdout is a stream of events, or
 * without a terminal, so deploy fails with the command that sets the secret.
 */
export function secretPrompt(opts: {
  json?: boolean;
}): SecretPrompt | undefined {
  const parent = parentSecretPrompt();
  if (parent) return parent;
  if (opts.json || !canPrompt()) return undefined;
  return terminalSecretPrompt();
}
