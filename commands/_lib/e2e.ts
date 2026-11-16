import { execFileSync } from "node:child_process";
import type { Runner } from "@pokit/core";

function dockerState(): string {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore", timeout: 15_000 });
    return "running";
  } catch {
    return "stopped";
  }
}

/**
 * Runs a turbo e2e task. turbo builds first, and skips a package whose tests
 * passed with the same code. Set TURBO_FORCE=true to run every package.
 */
export async function runE2e(r: Runner, task: string): Promise<void> {
  // The tests that need Docker skip themselves when the daemon isn't
  // running. turbo hashes this variable, so it doesn't replay a run that
  // skipped them once the daemon is running.
  process.env.NOTATION_E2E_DOCKER = dockerState();
  await r.exec(`pnpm exec turbo run ${task}`);
}
