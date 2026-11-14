import { PassThrough } from "node:stream";
import type { Deployment } from "@notation/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const deployment: Deployment = {
  app: "orders-app",
  stage: "prod",
  entryPoint: "/project/infra/app.ts",
  files: {},
};

const { setSecret, deleteSecret } = vi.hoisted(() => ({
  setSecret: vi.fn(),
  deleteSecret: vi.fn(),
}));

vi.mock("@notation/core", () => ({
  setSecret,
  deleteSecret,
}));
vi.mock("../src/compile", () => ({ compile: vi.fn(async () => undefined) }));

const { secretSet, secretDelete } = await import("../src/secret");

const logger = { ...console, info: vi.fn() };

const pipedInput = (text: string) => {
  const input = new PassThrough();
  input.end(text);
  return input;
};

beforeEach(() => {
  setSecret.mockReset();
  deleteSecret.mockReset();
});

describe("secretSet", () => {
  it("reads the value from stdin without a terminal, and drops one trailing line break", async () => {
    let value: string | undefined;
    setSecret.mockImplementation(async (opts) => {
      value = await opts.readValue();
    });

    await secretSet(deployment, "admin", {
      logger,
      streams: { input: pipedInput("hunter2\n") },
    });

    expect(setSecret).toHaveBeenCalledWith(
      expect.objectContaining({ deployment, id: "admin" }),
    );
    expect(value).toBe("hunter2");
    expect(logger.info).toHaveBeenCalledWith(
      "Set the secret admin for stage prod.",
    );
  });

  it("fails for an empty value", async () => {
    setSecret.mockImplementation(async (opts) => opts.readValue());

    await expect(
      secretSet(deployment, "admin", {
        logger,
        streams: { input: pipedInput("\n") },
      }),
    ).rejects.toThrow("No value was given for admin.");
  });
});

describe("secretDelete", () => {
  it("needs --yes without a terminal", async () => {
    deleteSecret.mockImplementation(async (opts) => opts.confirm());

    await expect(
      secretDelete(deployment, "admin", {
        logger,
        streams: { input: pipedInput("") },
      }),
    ).rejects.toThrow(
      "Deleting admin needs confirmation. Run the command in a terminal, or pass --yes.",
    );
  });

  it("deletes without asking with --yes", async () => {
    deleteSecret.mockImplementation(async (opts) => opts.confirm());

    await secretDelete(deployment, "admin", {
      logger,
      yes: true,
      streams: { input: pipedInput("") },
    });

    expect(logger.info).toHaveBeenCalledWith(
      "Deleted the secret admin for stage prod. The next `notation deploy` creates it again. `notation watch` doesn't, and a Worker that binds it fails to upload until it exists.",
    );
  });
});
