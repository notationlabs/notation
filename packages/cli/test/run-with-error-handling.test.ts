import { describe, expect, it, vi } from "vitest";
import { runWithCliErrorHandling } from "../src/run-with-error-handling";

describe("CLI error handling", () => {
  it("reports credential failures with command-specific guidance", async () => {
    const error = new Error("Could not load credentials");
    error.name = "CredentialsProviderError";
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const exitCode = await runWithCliErrorHandling(
      async () => {
        throw error;
      },
      { logger, command: "deploy" },
    );

    expect(exitCode).toBe(1);
    expect(logger.error).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledWith(
      "\nAWS credentials not found.",
      "\n\nEnsure you have a default profile set up in ~/.aws/credentials.",
      "\n\nIf using another profile run AWS_PROFILE=otherProfile notation deploy.\n",
    );
  });

  it("reports non-credential failures unchanged", async () => {
    const error = new Error("deploy failed");
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const exitCode = await runWithCliErrorHandling(
      async () => {
        throw error;
      },
      { logger, command: "deploy" },
    );

    expect(exitCode).toBe(1);
    expect(logger.error).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledWith(error);
  });
});
