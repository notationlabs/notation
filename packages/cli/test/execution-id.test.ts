import type { Deployment } from "@notation/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

type AppOptions = { deployment: Deployment; executionId: string };

const deployment: Deployment = {
  app: "orders-app",
  stage: "prod",
  entryPoint: "/project/infra/app.ts",
  files: {},
};

const { deployApp, destroyApp } = vi.hoisted(() => ({
  deployApp: vi.fn(async (_opts: AppOptions) => undefined),
  destroyApp: vi.fn(async (_opts: AppOptions) => undefined),
}));

vi.mock("@notation/core", async (importOriginal) => {
  const core = await importOriginal<typeof import("@notation/core")>();
  return {
    createLoggerReconcilerSubscriber: () => () => undefined,
    createNdjsonEventEmitter: () => () => undefined,
    deployApp,
    destroyApp,
    formatRequest: core.formatRequest,
    parseCredentialTarget: core.parseCredentialTarget,
    parseReplaceTarget: core.parseReplaceTarget,
    shellQuote: core.shellQuote,
    resolveDeploymentId: (d: Deployment) => `${d.app}:${d.stage}`,
  };
});
vi.mock("../src/compile", () => ({ compile: vi.fn(async () => undefined) }));

const { deploy, replaceRequest } = await import("../src/deploy");
const { destroy } = await import("../src/destroy");

describe.each([
  { command: "deploy", run: deploy, app: deployApp },
  { command: "destroy", run: destroy, app: destroyApp },
])("$command execution ID", ({ run, app }) => {
  beforeEach(() => {
    app.mockClear();
  });

  it("resumes the execution named by --execution-id", async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    await run(deployment, {
      executionId: "crashed-execution",
      logger,
    });

    expect(app).toHaveBeenCalledOnce();
    expect(app).toHaveBeenCalledWith(
      expect.objectContaining({
        deployment,
        executionId: "crashed-execution",
      }),
    );
    expect(logger.info).toHaveBeenCalledWith("Execution ID crashed-execution");
  });

  it("prints the command that resumes the execution", async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    await run(deployment, {
      executionId: "new-execution",
      resumeCommand: "notation deploy --config jobs.config.ts",
      logger,
    });

    expect(logger.info).toHaveBeenCalledWith(
      "To resume after a crash, run notation deploy --config jobs.config.ts --execution-id new-execution",
    );
  });

  it("starts a new execution and prints its ID before running it", async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    await run(deployment, { logger });
    await run(deployment, { logger });

    const [first, second] = app.mock.calls.map(([opts]) => opts.executionId);
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(second).not.toBe(first);
    expect(logger.info).toHaveBeenCalledWith(`Execution ID ${first}`);
    // Printed before any provider work, so a crash still leaves the ID behind.
    const printedAt =
      logger.info.mock.invocationCallOrder[
        logger.info.mock.calls.findIndex(
          ([line]) => line === `Execution ID ${first}`,
        )
      ]!;
    expect(printedAt).toBeLessThan(app.mock.invocationCallOrder[0]!);
  });
});

describe("deploy options", () => {
  it("skips compiling and drift detection when told to", async () => {
    const { compile } = await import("../src/compile");
    vi.mocked(compile).mockClear();
    deployApp.mockClear();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    await deploy(deployment, {
      compile: false,
      driftDetection: false,
      logger,
    });

    expect(compile).not.toHaveBeenCalled();
    expect(deployApp).toHaveBeenCalledWith(
      expect.objectContaining({ driftDetection: false }),
    );
  });

  it("compiles by default", async () => {
    const { compile } = await import("../src/compile");
    vi.mocked(compile).mockClear();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    await deploy(deployment, { logger });

    expect(compile).toHaveBeenCalledOnce();
  });
});

describe("replace flags", () => {
  it("reads --replace and --override-loss-protection, and passes them to deploy", async () => {
    deployApp.mockClear();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const requested = replaceRequest({
      replace: ["bucket:uploads@3c1f9a02"],
      overrideLossProtection: ["bucket:uploads"],
    });

    await deploy(deployment, { compile: false, logger, requested });

    expect(requested).toEqual({
      replace: [{ id: "bucket:uploads", instanceHash: "3c1f9a02" }],
      overrideLossProtection: ["bucket:uploads"],
    });
    expect(deployApp).toHaveBeenCalledWith(
      expect.objectContaining({ requested }),
    );
  });

  it("fails a --replace with no hash with the plan command for the same config and stage", async () => {
    deployApp.mockClear();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    await expect(
      deploy(deployment, {
        compile: false,
        logger,
        config: "infra/notation config.ts",
        requested: replaceRequest({ replace: ["bucket:uploads"] }),
      }),
    ).rejects.toThrow(
      "--replace bucket:uploads needs the instance hash, as --replace bucket:uploads@<instance hash>. Run notation plan --config 'infra/notation config.ts' --stage prod --replace bucket:uploads to print the deploy command with the hash.",
    );
    expect(deployApp).not.toHaveBeenCalled();
  });

  it("leaves a --replace with no hash on a resume to the check against the saved request", async () => {
    deployApp.mockClear();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    await deploy(deployment, {
      compile: false,
      logger,
      executionId: "crashed-execution",
      requested: replaceRequest({ replace: ["bucket:uploads"] }),
    });

    expect(deployApp).toHaveBeenCalledOnce();
  });

  it("fails a --credential with no version with the plan command", async () => {
    deployApp.mockClear();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    await expect(
      deploy(deployment, {
        compile: false,
        logger,
        requested: replaceRequest({ credential: ["app.privateKey=APP_KEY"] }),
      }),
    ).rejects.toThrow(
      "--credential app.privateKey needs the version, as --credential app.privateKey@<version>=APP_KEY. Run notation plan --stage prod --credential app.privateKey=APP_KEY to print the deploy command with the version.",
    );
    expect(deployApp).not.toHaveBeenCalled();
  });

  it("passes --credential to deploy as a target with a version and a variable", () => {
    expect(
      replaceRequest({ credential: ["app.privateKey@7b1e52c0=APP_KEY"] }),
    ).toEqual({
      replace: [],
      credential: [
        {
          id: "app",
          name: "privateKey",
          version: "7b1e52c0",
          variable: "APP_KEY",
        },
      ],
    });
  });

  it("gives no request without any flag", () => {
    expect(replaceRequest({})).toBeUndefined();
  });
});
