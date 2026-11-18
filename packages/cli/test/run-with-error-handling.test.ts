import { setConfigFile } from "@notation/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runWithErrorHandling } from "../src/run-with-error-handling";

const reconcilerFrame =
  "    at plan (file:///app/node_modules/@notation/reconciler/dist/plan.js:12:1)";
const infraFrame = "    at defineBucket (file:///app/infra.ts:4:3)";

describe("CLI error handling", () => {
  beforeEach(() => setConfigFile("/app/notation.config.ts"));
  afterEach(() => setConfigFile(undefined));

  it("reports credential failures with command-specific guidance", async () => {
    const error = new Error("Could not load credentials");
    error.name = "CredentialsProviderError";
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const exitCode = await runWithErrorHandling(
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

  it("prints the message and the project's frames of any other error", async () => {
    const error = new Error("deploy failed");
    error.stack = ["Error: deploy failed", reconcilerFrame, infraFrame].join(
      "\n",
    );
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const exitCode = await runWithErrorHandling(
      async () => {
        throw error;
      },
      { logger, command: "deploy" },
    );

    expect(exitCode).toBe(1);
    expect(logger.error).toHaveBeenCalledExactlyOnceWith(
      `Error: deploy failed\n${infraFrame}`,
    );
  });

  it("prints one line for an error that an event reported", async () => {
    const error = Object.assign(new Error("The bucket still has objects"), {
      reportedOperation: { operation: "delete", resourceId: "bucket" },
    });
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const exitCode = await runWithErrorHandling(
      async () => {
        throw error;
      },
      { logger, command: "destroy" },
    );

    expect(exitCode).toBe(1);
    expect(logger.error).toHaveBeenCalledExactlyOnceWith(
      "\nnotation destroy stopped because delete bucket failed.",
    );
  });

  it("adds the message of an error that wraps a reported error", async () => {
    const cause = Object.assign(new Error("Could not read a credential"), {
      reportedOperation: {
        operation: "rotate",
        resourceId: "app",
        credential: "privateKey",
      },
    });
    const error = new Error("Run notation deploy --stage prod", { cause });
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    await runWithErrorHandling(
      async () => {
        throw error;
      },
      { logger, command: "deploy" },
    );

    expect(logger.error.mock.calls).toEqual([
      ["\nnotation deploy stopped because rotate privateKey of app failed."],
      ["Run notation deploy --stage prod"],
    ]);
  });

  it("prints any other error unchanged with debug", async () => {
    const error = new Error("deploy failed");
    const stack = ["Error: deploy failed", reconcilerFrame, infraFrame].join(
      "\n",
    );
    error.stack = stack;
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    await runWithErrorHandling(
      async () => {
        throw error;
      },
      { logger, command: "deploy", debug: true },
    );

    expect(logger.error).toHaveBeenCalledExactlyOnceWith(error);
    expect(error.stack).toBe(stack);
  });

  it("prints a reported error in full with debug", async () => {
    const error = Object.assign(new Error("The bucket still has objects"), {
      reportedOperation: { operation: "delete", resourceId: "bucket" },
    });
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    await runWithErrorHandling(
      async () => {
        throw error;
      },
      { logger, command: "destroy", debug: true },
    );

    expect(logger.error).toHaveBeenCalledExactlyOnceWith(error);
  });
});
