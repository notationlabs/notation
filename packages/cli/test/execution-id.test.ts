import type { Deployment } from "@notation/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

type AppOptions = { deployment: Deployment; executionId: string };

const deployment: Deployment = {
  app: "orders-app",
  stage: "prod",
  entry: "orders",
  entryPoint: "/project/infra/app.ts",
};

const { deployApp, destroyApp } = vi.hoisted(() => ({
  deployApp: vi.fn(async (_opts: AppOptions) => undefined),
  destroyApp: vi.fn(async (_opts: AppOptions) => undefined),
}));

vi.mock("@notation/core", () => ({
  createLoggerReconcilerSubscriber: () => () => undefined,
  createNdjsonEventEmitter: () => () => undefined,
  deployApp,
  destroyApp,
  resolveDeploymentId: (d: Deployment) => `${d.app}:${d.stage}:${d.entry}`,
}));
vi.mock("../src/compile", () => ({ compile: vi.fn(async () => undefined) }));

const { deploy } = await import("../src/deploy");
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

    await run(deployment, { executionId: "crashed-execution", logger });

    expect(app).toHaveBeenCalledOnce();
    expect(app).toHaveBeenCalledWith(
      expect.objectContaining({
        deployment,
        executionId: "crashed-execution",
      }),
    );
    expect(logger.info).toHaveBeenCalledWith("Execution ID crashed-execution");
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
