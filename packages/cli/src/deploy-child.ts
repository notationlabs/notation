import {
  createLoggerReconcilerSubscriber,
  type DeploymentIdentity,
  type ReconcilerEventEmitter,
} from "@notation/core";
import { spawn as nodeSpawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { Logger } from "./logger";

export type DeployChildOptions = {
  deployment: DeploymentIdentity;
  executionId: string;
  logger: Logger;
  spawn?: typeof nodeSpawn;
  proc?: Pick<NodeJS.Process, "on" | "off" | "kill" | "pid">;
};

const forwardedSignals = ["SIGINT", "SIGTERM"] as const;

/**
 * Runs one deploy in a child CLI process. The infra bundle, its resource
 * graph and the module cache live and die with the child, so a long-lived
 * parent (watch) never accumulates them. Events arrive as NDJSON on the
 * child's stdout; its logs pass through on stderr.
 */
export function deployInChild({
  deployment,
  executionId,
  logger,
  spawn = nodeSpawn,
  proc = process,
}: DeployChildOptions): Promise<void> {
  const emit = createLoggerReconcilerSubscriber({ logger });
  const args = [
    ...process.execArgv,
    process.argv[1]!,
    "deploy",
    deployment.entry,
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
      stdio: ["ignore", "pipe", "inherit"],
    });

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
