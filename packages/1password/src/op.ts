import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import path from "node:path";
import { scrubSecretValues } from "@notation/utils";

const INSTALL_GUIDE = "https://developer.1password.com/docs/cli/get-started/";

const TIMEOUT_MS = 120_000;

/** A call to `op` that failed. `stderr` has every recorded value scrubbed. */
export class OnePasswordError extends Error {
  readonly exitCode: number | null;
  readonly stderr: string;

  constructor(message: string, exitCode: number | null, stderr: string) {
    super(message);
    this.name = "OnePasswordError";
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

/**
 * Runs `op item get <item> --vault=<vault> --format json`, and returns its
 * stdout. The environment is passed through, so `op` chooses how to sign in.
 */
export function opItemGet(
  item: string,
  vault: string,
  timeoutMs = TIMEOUT_MS,
): Promise<string> {
  return runOp(
    ["item", "get", item, `--vault=${vault}`, "--format", "json"],
    timeoutMs,
  );
}

// `spawn`, because `execFile` ignores `stdio` and always gives the child a
// pipe on stdin.
function runOp(args: string[], timeoutMs: number): Promise<string> {
  const file = opPath();
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    // The error's stderr is the message, so that a timeout never counts as
    // a failure of one item.
    const timer = setTimeout(() => {
      child.kill();
      const message = `op did not finish within ${timeoutMs / 1000} seconds, and was stopped.`;
      reject(new OnePasswordError(message, null, message));
    }, timeoutMs);
    child.on("error", () => clearTimeout(timer));
    child.on("close", () => clearTimeout(timer));
    child.on("error", (error: NodeJS.ErrnoException) => {
      reject(error.code === "ENOENT" ? missingOp() : error);
    });
    child.on("close", (exitCode, signal) => {
      if (exitCode === 0) {
        resolve(Buffer.concat(stdout).toString("utf8"));
        return;
      }
      // The stdout of a failed call is discarded, as it can hold values.
      const scrubbed = scrubSecretValues(
        Buffer.concat(stderr).toString("utf8"),
      ).trim();
      // `op` starts each line with `[ERROR]` and a timestamp.
      const text = scrubbed.replace(/^\[ERROR\] \S+ \S+ /gm, "");
      const message =
        exitCode === null
          ? `op was stopped by ${signal}. ${text}`
          : `op failed with exit code ${exitCode}: ${text}`;
      reject(new OnePasswordError(message.trim(), exitCode, scrubbed));
    });
  });
}

function missingOp(): Error {
  return new Error(
    `The 1Password CLI, op, is required, and it isn't on PATH. Install it: ${INSTALL_GUIDE}`,
  );
}

// On Windows, a program name without a path is looked up in the current
// folder before PATH. The current folder is the repository, so an `op.exe`
// in it must not run.
function opPath(): string {
  if (process.platform !== "win32") return "op";
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!path.isAbsolute(directory)) continue;
    const file = path.join(directory, "op.exe");
    if (isFile(file)) return file;
  }
  throw missingOp();
}

function isFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}
