import {
  createLoggerReconcilerSubscriber,
  createNdjsonEventEmitter,
  type ReconcilerEventEmitter,
} from "@notation/core";
import { styleText } from "node:util";
import type { Logger } from "./logger";
import { redirectStdoutToStderr } from "./stdio";

export type OutputMode = "pretty" | "json";

/**
 * `--json` gives JSON and `--pretty` gives pretty output. Without either
 * flag, the output is pretty on a terminal or in CI, and JSON otherwise.
 */
export function resolveOutputMode(
  flags: { json?: boolean; pretty?: boolean },
  stdout: { isTTY?: boolean } = process.stdout,
  env: { CI?: string } = process.env,
): OutputMode {
  if (flags.json) return "json";
  if (flags.pretty) return "pretty";
  const ci = Boolean(env.CI) && env.CI !== "false" && env.CI !== "0";
  return stdout.isTTY || ci ? "pretty" : "json";
}

/**
 * In JSON mode, events go to stdout as NDJSON, and all other output moves to
 * stderr.
 */
export function createEventRenderer(
  mode: OutputMode,
  logger: Logger,
): ReconcilerEventEmitter {
  if (mode === "json") {
    return createNdjsonEventEmitter(redirectStdoutToStderr().write);
  }
  return createPrettyRenderer(logger);
}

/**
 * Logs each event as one pretty line at the event's level. The colours of a
 * line follow the stream it is written to: `infoStream` for info lines and
 * stderr for warnings and errors. styleText drops the colours when that
 * stream is not a terminal or NO_COLOR is set.
 */
export function createPrettyRenderer(
  logger: Logger,
  // Set it to stderr when stdout has been redirected there.
  infoStream: NodeJS.WriteStream = process.stdout,
): ReconcilerEventEmitter {
  return createLoggerReconcilerSubscriber({
    logger,
    style: (format, text, level) =>
      styleText(format, text, {
        stream: level === "info" ? infoStream : process.stderr,
      }),
  });
}
