import { describe, expect, it } from "vitest";
import type { NotationConfig } from "src/config/config";
import { resolveDeployment, resolveDeploymentId } from "src/config/deployment";
import { fromProjectRoot } from "src/utils/paths";

const config: NotationConfig = {
  app: "orders-app",
  entries: { orders: "infra/api.ts", billing: "infra/billing.ts" },
};

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
      resolveDeployment(config, { entry: "orders", stage: "prod" }),
    ).toEqual({
      app: "orders-app",
      stage: "prod",
      entry: "orders",
      entryPoint: fromProjectRoot("infra/api.ts"),
    });
  });

  it("falls back to the default stage", () => {
    const deployment = resolveDeployment(
      { ...config, defaultStage: "dev" },
      { entry: "billing" },
    );
    expect(deployment.stage).toBe("dev");
  });

  it("prefers the given stage to the default stage", () => {
    const deployment = resolveDeployment(
      { ...config, defaultStage: "dev" },
      { entry: "billing", stage: "staging" },
    );
    expect(deployment.stage).toBe("staging");
  });

  it("requires a stage when the config has no default stage", () => {
    expect(() => resolveDeployment(config, { entry: "orders" })).toThrow(
      "No stage given. Pass --stage, or set defaultStage in notation.config.ts",
    );
  });

  it("checks the given stage", () => {
    expect(() =>
      resolveDeployment(config, { entry: "orders", stage: "-prod" }),
    ).toThrow('stage "-prod" is not name-safe');
  });

  it("lists the entries when the name matches none", () => {
    expect(() =>
      resolveDeployment(config, { entry: "infra/api.ts", stage: "prod" }),
    ).toThrow(
      'No entry named "infra/api.ts" in notation.config.ts. Entries: orders, billing',
    );
  });

  it("does not resolve inherited properties as entries", () => {
    expect(() =>
      resolveDeployment(config, { entry: "constructor", stage: "prod" }),
    ).toThrow('No entry named "constructor"');
  });
});
