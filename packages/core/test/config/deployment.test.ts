import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { NotationConfig } from "src/config/config";
import {
  resolveDeployment,
  resolveDeploymentId,
  resolveEntryPoint,
} from "src/config/deployment";

const root = realpathSync(
  mkdtempSync(path.join(tmpdir(), "notation-deployment-")),
);
mkdirSync(path.join(root, "infra"));
writeFileSync(path.join(root, "infra/api.ts"), "");
writeFileSync(path.join(root, "infra/billing.ts"), "");
afterAll(() => rmSync(root, { recursive: true, force: true }));

const config: NotationConfig = {
  app: "orders-app",
  entries: { orders: "infra/api.ts", billing: "infra/billing.ts" },
};
const project = { root, config };

describe("resolveDeploymentId", () => {
  it("keys a deployment by app, stage and entry", () => {
    expect(
      resolveDeploymentId({
        app: "orders-app",
        stage: "prod",
        entry: "orders",
      }),
    ).toBe("orders-app:prod:orders");
  });

  it("rejects a name that is not name-safe", () => {
    expect(() =>
      resolveDeploymentId({
        app: "orders-app",
        stage: "Prod",
        entry: "orders",
      }),
    ).toThrow('stage "Prod" is not name-safe');
  });
});

describe("resolveDeployment", () => {
  it("resolves an entry name to its file and the given stage", () => {
    expect(
      resolveDeployment(project, { entry: "orders", stage: "prod" }),
    ).toEqual({
      app: "orders-app",
      stage: "prod",
      entry: "orders",
      entryPoint: path.join(root, "infra/api.ts"),
    });
  });

  it("falls back to the default stage", () => {
    const deployment = resolveDeployment(
      { root, config: { ...config, defaultStage: "dev" } },
      { entry: "billing" },
    );
    expect(deployment.stage).toBe("dev");
  });

  it("prefers the given stage to the default stage", () => {
    const deployment = resolveDeployment(
      { root, config: { ...config, defaultStage: "dev" } },
      { entry: "billing", stage: "staging" },
    );
    expect(deployment.stage).toBe("staging");
  });

  it("requires a stage when the config has no default stage", () => {
    expect(() => resolveDeployment(project, { entry: "orders" })).toThrow(
      "No stage given. Pass --stage, or set defaultStage in notation.config.ts",
    );
  });

  it("checks the given stage", () => {
    expect(() =>
      resolveDeployment(project, { entry: "orders", stage: "-prod" }),
    ).toThrow('stage "-prod" is not name-safe');
  });

  it("lists the entries when the name matches none", () => {
    expect(() =>
      resolveDeployment(project, { entry: "infra/api.ts", stage: "prod" }),
    ).toThrow(
      'No entry named "infra/api.ts" in notation.config.ts. Entries: orders, billing',
    );
  });

  it("does not resolve inherited properties as entries", () => {
    expect(() =>
      resolveDeployment(project, { entry: "constructor", stage: "prod" }),
    ).toThrow('No entry named "constructor"');
  });
});

describe("resolveEntryPoint", () => {
  it("fails when the entry file does not exist", () => {
    const missing = {
      root,
      config: { ...config, entries: { orders: "infra/gone.ts" } },
    };
    expect(() => resolveEntryPoint(missing, "orders")).toThrow(
      `Entry file not found: ${path.join(root, "infra/gone.ts")}, the file of entry "orders" in notation.config.ts`,
    );
  });
});
