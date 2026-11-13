import {
  configPath,
  createLoggerReconcilerSubscriber,
  recordSecretValue,
  type DeploymentIdentity,
  type ReconcilerEventEmitter,
  type SecretPrompt,
} from "@notation/core";
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import type { Logger } from "./logger";

export type DeployChildOptions = {
  deployment: DeploymentIdentity;
  executionId: string;
  logger: Logger;
  /**
   * Answers the child's questions for the values of secrets without a
   * source. Without it, the child fails when it needs one.
   */
  promptSecret?: SecretPrompt;
  spawn?: typeof nodeSpawn;
  proc?: Pick<NodeJS.Process, "on" | "off" | "kill" | "pid">;
};

const forwardedSignals = ["SIGINT", "SIGTERM"] as const;

/**
 * Runs one deploy in a child CLI process. The infra bundle, its resource
 * graph and the module cache live and die with the child, so a long-lived
 * parent (watch) never accumulates them. Events arrive as NDJSON on the
 * child's stdout; its logs pass through on stderr.
 *
 * The child loads the same config file again and resolves the deployment
 * from the stage. `watch` stops when the config changes, so the child reads
 * the same config as the parent.
 *
 * The child has no terminal, so with `promptSecret` it asks this process for
 * secret values over an IPC channel.
 */
export function deployInChild({
  deployment,
  executionId,
  logger,
  promptSecret,
  spawn = nodeSpawn,
  proc = process,
}: DeployChildOptions): Promise<void> {
  const emit = createLoggerReconcilerSubscriber({ logger });
  const args = [
    ...process.execArgv,
    process.argv[1]!,
    "deploy",
    "--config",
    configPath(),
    "--stage",
    deployment.stage,
    "--json",
    "--no-compile",
    "--no-drift-detection",
    "--execution-id",
    executionId,
  ];

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      stdio: promptSecret
        ? ["ignore", "pipe", "inherit", "ipc"]
        : ["ignore", "pipe", "inherit"],
      ...(promptSecret ? { env: { ...process.env, [PROMPT_ENV]: "ipc" } } : {}),
    });
    if (promptSecret) answerSecretPrompts(child, promptSecret);

    // A parent signalled on its own (e.g. by a task runner) would otherwise
    // exit and leave the deploy running unobserved. Pass the signal on, then
    // re-raise it so the parent still exits as it would without a handler.
    const onSignal = (signal: NodeJS.Signals) => {
      stopForwarding();
      child.kill(signal);
      proc.kill(proc.pid, signal);
    };
    const stopForwarding = () => {
      for (const signal of forwardedSignals) proc.off(signal, onSignal);
    };
    for (const signal of forwardedSignals) proc.on(signal, onSignal);

    const events = createInterface({ input: child.stdout! });
    events.on("line", (line) => {
      if (!line.trim()) return;
      try {
        const { version: _, ...event } = JSON.parse(line);
        void emit(event as Parameters<ReconcilerEventEmitter>[0]);
      } catch {
        logger.info(line);
      }
    });

    child.once("error", (err) => {
      stopForwarding();
      reject(err);
    });
    child.once("close", (code) => {
      stopForwarding();
      if (code === 0) resolve();
      else reject(new Error(`Deploy exited with code ${code}`));
    });
  });
}

const PROMPT_ENV = "NOTATION_SECRET_PROMPT";
const PROMPT_MESSAGE = "notation:secret-prompt";
const ANSWER_MESSAGE = "notation:secret-answer";

type PromptMessage = {
  type: typeof PROMPT_MESSAGE;
  requestId: string;
  id: string;
  stage: string;
};

type AnswerMessage = {
  type: typeof ANSWER_MESSAGE;
  requestId: string;
} & ({ value: string } | { error: string });

function answerSecretPrompts(child: ChildProcess, prompt: SecretPrompt) {
  child.on("message", (message: PromptMessage) => {
    if (message?.type !== PROMPT_MESSAGE) return;
    const { requestId, id, stage } = message;
    const reply = (answer: Omit<AnswerMessage, "type" | "requestId">) => {
      if (!child.connected) return;
      child.send({ type: ANSWER_MESSAGE, requestId, ...answer });
    };
    prompt({ id, stage }).then(
      (value) => reply({ value }),
      (error: unknown) =>
        reply({
          error: error instanceof Error ? error.message : String(error),
        }),
    );
  });
}

/**
 * The prompt of a deploy that `deployInChild` started with `promptSecret`:
 * it asks the parent process. Undefined in any other process.
 */
export function parentSecretPrompt(
  proc: Pick<NodeJS.Process, "env" | "send" | "on" | "off"> = process,
): SecretPrompt | undefined {
  if (proc.env[PROMPT_ENV] !== "ipc" || !proc.send) return undefined;
  const send = proc.send.bind(proc);
  return (request) =>
    new Promise((resolve, reject) => {
      const requestId = randomUUID();
      // The listener keeps the channel open, so it is removed once the
      // answer arrives, and the process can exit after the deploy.
      const onMessage = (message: AnswerMessage) => {
        if (message?.type !== ANSWER_MESSAGE) return;
        if (message.requestId !== requestId) return;
        proc.off("message", onMessage);
        if ("value" in message) {
          recordSecretValue(message.value);
          resolve(message.value);
        } else {
          reject(new Error(message.error));
        }
      };
      proc.on("message", onMessage);
      send({ type: PROMPT_MESSAGE, requestId, ...request });
    });
}
