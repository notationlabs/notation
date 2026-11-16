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
    formatOverrides: core.formatOverrides,
    parseCredentialTarget: core.parseCredentialTarget,
    parseReplaceTarget: core.parseReplaceTarget,
    shellQuote: core.shellQuote,
    UnobtainableCredentialError: core.UnobtainableCredentialError,
    resolveDeploymentId: (d: Deployment) => `${d.app}:${d.stage}`,
  };
});
vi.mock("../src/compile", () => ({ compile: vi.fn(async () => undefined) }));

const { deploy, parseOverrides } = await import("../src/deploy");
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
    const overrides = parseOverrides({
      replace: ["bucket:uploads@3c1f9a02"],
      overrideLossProtection: ["bucket:uploads"],
    });

    await deploy(deployment, { compile: false, logger, overrides });

    expect(overrides).toEqual({
      replace: [{ id: "bucket:uploads", instanceHash: "3c1f9a02" }],
      overrideLossProtection: ["bucket:uploads"],
    });
    expect(deployApp).toHaveBeenCalledWith(
      expect.objectContaining({ overrides }),
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
        overrides: parseOverrides({ replace: ["bucket:uploads"] }),
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
      overrides: parseOverrides({ replace: ["bucket:uploads"] }),
    });

    expect(deployApp).toHaveBeenCalledOnce();
  });

  it("fails a --credential with no instance hash with the plan command", async () => {
    deployApp.mockClear();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    await expect(
      deploy(deployment, {
        compile: false,
        logger,
        overrides: parseOverrides({ credential: ["app.privateKey=APP_KEY"] }),
      }),
    ).rejects.toThrow(
      "--credential app.privateKey needs the instance hash, as --credential app.privateKey@<instance hash>=APP_KEY. Run notation plan --stage prod --credential app.privateKey=APP_KEY to print the deploy command with the hash.",
    );
    expect(deployApp).not.toHaveBeenCalled();
  });

  it("passes --credential to deploy as a target with an instance hash and a variable", () => {
    expect(
      parseOverrides({ credential: ["app.privateKey@7b1e52c0=APP_KEY"] }),
    ).toEqual({
      replace: [],
      credential: [
        {
          id: "app",
          name: "privateKey",
          instanceHash: "7b1e52c0",
          variable: "APP_KEY",
        },
      ],
    });
  });

  it("fails for a credential that deploy cannot get, with deploy commands for the same config, stage and request", async () => {
    const core =
      await vi.importActual<typeof import("@notation/core")>("@notation/core");
    deployApp.mockRejectedValueOnce(
      new core.UnobtainableCredentialError(
        [
          {
            consumer: "app-key-secret",
            producer: "app",
            producerType: "github/App",
            name: "privateKey",
            reason: "not-held",
            instanceHash: "5d2e8b17",
          },
        ],
        { replace: [{ id: "queue", instanceHash: "0c4d9e21" }] },
      ),
    );
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const error = await deploy(deployment, {
      compile: false,
      logger,
      config: "jobs.config.ts",
      overrides: parseOverrides({ replace: ["queue@0c4d9e21"] }),
    }).catch((e: Error) => e);

    expect((error as Error).message).toBe(
      [
        "app-key-secret takes app.privateKey, and the deploy run that received its value has ended. Notation does not store the value, and github/App has no operation that issues another.",
        "",
        "  Issue a new value of privateKey at the provider of github/App. Then set the environment variable APP_PRIVATE_KEY to the value, and pass it:",
        "    notation deploy --config jobs.config.ts --stage prod --replace queue@0c4d9e21 --credential app.privateKey@5d2e8b17=APP_PRIVATE_KEY",
        "",
        "  Or replace app. Deploy deletes app and creates it again with a new value, so whatever exists only in the old app is lost:",
        "    notation deploy --config jobs.config.ts --stage prod --replace queue@0c4d9e21 --replace app@5d2e8b17",
      ].join("\n"),
    );
    expect((error as Error).stack).toContain("--stage prod");
  });

  it("gives no request without any flag", () => {
    expect(parseOverrides({})).toBeUndefined();
  });
});
