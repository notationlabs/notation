import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { NotationConfig } from "src/config/config";
import {
  resolveDeployment,
  resolveDeploymentId,
  resolveDeploymentIdentity,
  resolveEntryPoint,
} from "src/config/deployment";
import { projectRoot, setConfigFile } from "src/utils/paths";

const root = realpathSync(
  mkdtempSync(path.join(tmpdir(), "notation-deployment-")),
);
mkdirSync(path.join(root, "infra"));
writeFileSync(path.join(root, "infra/api.ts"), "");
mkdirSync(path.join(root, "jobs/infra"), { recursive: true });
writeFileSync(path.join(root, "jobs/infra/run.ts"), "");
writeFileSync(path.join(root, "notation.config.ts"), "");
const cwd = process.cwd();
beforeAll(() => process.chdir(root));
afterAll(() => {
  process.chdir(cwd);
  rmSync(root, { recursive: true, force: true });
});

const config: NotationConfig = { app: "orders-app", entry: "infra/api.ts" };
const project = { config };

describe("resolveDeploymentId", () => {
  it("keys a deployment by app and stage", () => {
    expect(resolveDeploymentId({ app: "orders-app", stage: "prod" })).toBe(
      "orders-app:prod",
    );
  });

  it("rejects a name that is not name-safe", () => {
    expect(() =>
      resolveDeploymentId({ app: "orders-app", stage: "Prod" }),
    ).toThrow('stage "Prod" is not name-safe');
  });
});

describe("resolveDeployment", () => {
  it("resolves the entry file and the given stage", () => {
    expect(resolveDeployment(project, { stage: "prod" })).toEqual({
      app: "orders-app",
      stage: "prod",
      entryPoint: path.join(root, "infra/api.ts"),
    });
  });

  it("falls back to the default stage", () => {
    const deployment = resolveDeployment({
      config: { ...config, defaultStage: "dev" },
    });
    expect(deployment.stage).toBe("dev");
  });

  it("prefers the given stage to the default stage", () => {
    const deployment = resolveDeployment(
      { config: { ...config, defaultStage: "dev" } },
      { stage: "staging" },
    );
    expect(deployment.stage).toBe("staging");
  });

  it("requires a stage when the config has no default stage", () => {
    expect(() => resolveDeployment(project)).toThrow(
      "No stage given. Pass --stage, or set defaultStage in notation.config.ts",
    );
  });

  it("checks the given stage", () => {
    expect(() => resolveDeployment(project, { stage: "-prod" })).toThrow(
      'stage "-prod" is not name-safe',
    );
  });
});

describe("resolveDeploymentIdentity", () => {
  it("does not need the entry file to exist", () => {
    const missing = { config: { ...config, entry: "infra/gone.ts" } };
    expect(resolveDeploymentIdentity(missing, { stage: "prod" })).toEqual({
      app: "orders-app",
      stage: "prod",
    });
  });
});

describe("resolveEntryPoint", () => {
  it("fails when the entry file does not exist", () => {
    const missing = { config: { ...config, entry: "infra/gone.ts" } };
    expect(() => resolveEntryPoint(missing)).toThrow(
      `Entry file not found: ${path.join(root, "infra/gone.ts")}, the entry in notation.config.ts`,
    );
  });
});

describe("a config given by path", () => {
  afterEach(() => setConfigFile(undefined));

  it("resolves the entry against the config's directory", () => {
    setConfigFile("jobs/jobs.config.ts");
    expect(projectRoot()).toBe(path.join(root, "jobs"));
    expect(
      resolveEntryPoint({ config: { app: "jobs", entry: "infra/run.ts" } }),
    ).toBe(path.join(root, "jobs/infra/run.ts"));
  });

  it("names the config file in errors", () => {
    setConfigFile("jobs/jobs.config.ts");
    expect(() => resolveDeployment({ config })).toThrow(
      "No stage given. Pass --stage, or set defaultStage in jobs.config.ts",
    );
  });
});
