import {
  deployApp,
  formatRequest,
  parseCredentialTarget,
  parseReplaceTarget,
  resolveDeploymentId,
  type Deployment,
  type ReplaceRequest,
  type SecretPrompt,
} from "@notation/core";
import { randomUUID } from "node:crypto";
import { compile } from "./compile";
import { defaultLogger, type Logger } from "./logger";
import { createEventRenderer, type OutputMode } from "./output";
import { targetFlags } from "./plan";
import { canPrompt, terminalSecretPrompt } from "./prompt";

export type DeployCommandOptions = {
  output?: OutputMode;
  executionId?: string;
  // Printed with the execution ID, such as `notation deploy`.
  resumeCommand?: string;
  // Off when the caller (e.g. watch) has already compiled.
  compile?: boolean;
  driftDetection?: boolean;
  logger?: Logger;
  /**
   * Asks on the terminal for secret values even in JSON output. `watch` sets
   * it for the deploys it runs, whose stdout carries events to `watch`. The
   * CLI also sets it when the output is JSON only because stdout is not a
   * terminal.
   */
  promptSecrets?: boolean;
  /** Defaults to the prompt that `secretPrompt` picks. */
  promptSecret?: SecretPrompt;
  /**
   * The request from `--replace`, `--override-loss-protection` and
   * `--credential`.
   */
  requested?: ReplaceRequest;
  /** The `--config` path, for the plan command that a missing hash prints. */
  config?: string;
};

export async function deploy(
  deployment: Deployment,
  opts: DeployCommandOptions = {},
) {
  const logger = opts.logger ?? defaultLogger;
  const output = opts.output ?? "pretty";
  const emit = createEventRenderer(output, logger);
  assertHashesGiven(deployment, opts);

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
    requested: opts.requested,
    promptSecret:
      opts.promptSecret ??
      secretPrompt({
        json: output === "json",
        promptSecrets: opts.promptSecrets,
      }),
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

/**
 * Throws if a `--replace` has no instance hash, or a `--credential` has no
 * version, with the plan command that prints the deploy command with them.
 * Skipped on a resume, so that `assertSameRequest` reports a request that
 * differs from the saved one.
 */
function assertHashesGiven(
  deployment: Deployment,
  opts: DeployCommandOptions,
): void {
  if (opts.executionId !== undefined) return;
  const plan = `Run notation plan ${targetFlags(deployment, opts.config)} ${formatRequest(opts.requested)}`;
  const missing = opts.requested?.replace.find(
    (target) => target.instanceHash === undefined,
  );
  if (missing) {
    throw new Error(
      `--replace ${missing.id} needs the instance hash, as --replace ${missing.id}@<instance hash>. ${plan} to print the deploy command with the hash.`,
    );
  }
  const unversioned = opts.requested?.credential?.find(
    (target) => target.version === undefined,
  );
  if (unversioned) {
    const { id, name, variable } = unversioned;
    throw new Error(
      `--credential ${id}.${name} needs the version, as --credential ${id}.${name}@<version>=${variable}. ${plan} to print the deploy command with the version.`,
    );
  }
}

/**
 * Reads `--replace`, `--override-loss-protection` and `--credential`.
 * Undefined when none is given, so that a resume uses the request that the
 * execution saved.
 */
export function replaceRequest(options: {
  replace?: string[];
  overrideLossProtection?: string[];
  credential?: string[];
}): ReplaceRequest | undefined {
  if (
    !options.replace &&
    !options.overrideLossProtection &&
    !options.credential
  ) {
    return undefined;
  }
  return {
    replace: (options.replace ?? []).map(parseReplaceTarget),
    ...(options.overrideLossProtection
      ? { overrideLossProtection: options.overrideLossProtection }
      : {}),
    ...(options.credential
      ? { credential: options.credential.map(parseCredentialTarget) }
      : {}),
  };
}
