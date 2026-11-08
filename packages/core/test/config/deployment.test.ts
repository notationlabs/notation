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
  parseDeploymentId,
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
      files: {},
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

describe("parseDeploymentId", () => {
  it("reads the app and stage from a state key", () => {
    expect(parseDeploymentId("orders-app:prod")).toEqual({
      app: "orders-app",
      stage: "prod",
    });
  });

  it.each(["infra/api.ts", "orders-app", "orders-app:prod:eu", "Orders:prod"])(
    "returns undefined for %s",
    (deploymentId) => {
      expect(parseDeploymentId(deploymentId)).toBeUndefined();
    },
  );
});

describe("resolveDeployment of a resumed execution", () => {
  const execution = {
    id: "crashed-execution",
    deployment: { app: "orders-app", stage: "prod" },
  };
  const withDefault = { config: { ...config, defaultStage: "dev" } };

  it("takes the stage from the execution, not the default stage", () => {
    expect(resolveDeployment(withDefault, { execution }).stage).toBe("prod");
  });

  it("accepts a given stage that matches the execution", () => {
    expect(resolveDeployment(project, { stage: "prod", execution }).stage).toBe(
      "prod",
    );
  });

  it("rejects a given stage that does not match the execution", () => {
    expect(() =>
      resolveDeployment(withDefault, { stage: "dev", execution }),
    ).toThrow(
      "Execution crashed-execution is for stage prod, not dev. Leave out --stage, or pass --stage prod",
    );
  });

  it("rejects a config with another app", () => {
    const jobs = { config: { ...config, app: "orders-jobs" } };
    expect(() => resolveDeployment(jobs, { execution })).toThrow(
      "Execution crashed-execution is for app orders-app, but notation.config.ts has app orders-jobs. Pass --config with the config of app orders-app",
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
