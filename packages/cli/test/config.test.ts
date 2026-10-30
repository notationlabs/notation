import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, loadDeployment, loadEntryPoint } from "../src/config";

let root: string;

// Inside the package, so the config's import of @notation/core resolves.
beforeEach(async () => {
  const tmp = path.join(import.meta.dirname, "../tmp");
  await mkdir(tmp, { recursive: true });
  root = await mkdtemp(path.join(tmp, "config-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function writeConfig(source: string) {
  return writeFile(path.join(root, "notation.config.ts"), source);
}

const ordersConfig = `
import { defineConfig } from "@notation/core";

export default defineConfig({
  app: "orders-app",
  entries: { orders: "infra/api.ts" },
  runtimeModules: "src/**/*.fn.ts",
  defaultStage: "dev",
});
`;

describe("loadConfig", () => {
  it("loads notation.config.ts from the root", async () => {
    await writeConfig(ordersConfig);

    await expect(loadConfig({ root })).resolves.toEqual({
      app: "orders-app",
      entries: { orders: "infra/api.ts" },
      runtimeModules: "src/**/*.fn.ts",
      defaultStage: "dev",
    });
  });

  it("bundles the config's relative imports", async () => {
    await writeFile(
      path.join(root, "app-name.ts"),
      `export const app: string = "orders-app";`,
    );
    await writeConfig(`
      import { app } from "./app-name";
      export default { app, entries: { orders: "infra/api.ts" } };
    `);

    await expect(loadConfig({ root })).resolves.toMatchObject({
      app: "orders-app",
    });
  });

  it("reads the config again after it changes", async () => {
    await writeConfig(ordersConfig);
    await loadConfig({ root });
    await writeConfig(ordersConfig.replace("orders-app", "billing-app"));

    await expect(loadConfig({ root })).resolves.toMatchObject({
      app: "billing-app",
    });
  });

  it("fails when the root has no config", async () => {
    await expect(loadConfig({ root })).rejects.toThrow(
      `No notation.config.ts found in ${root}`,
    );
  });

  it("checks names at runtime", async () => {
    await writeConfig(`
      export default { app: "Orders_App", entries: { orders: "infra/api.ts" } };
    `);

    await expect(loadConfig({ root })).rejects.toThrow(
      'app "Orders_App" is not name-safe',
    );
  });
});

describe("loadDeployment", () => {
  beforeEach(() => writeConfig(ordersConfig));

  it("resolves an entry name and stage from the command line", async () => {
    await expect(
      loadDeployment({ entry: "orders", stage: "prod" }, { root }),
    ).resolves.toEqual({
      app: "orders-app",
      stage: "prod",
      entry: "orders",
      entryPoint: path.join(root, "infra/api.ts"),
    });
  });

  it("falls back to the default stage", async () => {
    await expect(
      loadDeployment({ entry: "orders" }, { root }),
    ).resolves.toMatchObject({ stage: "dev" });
  });

  it("checks the stage from the command line", async () => {
    await expect(
      loadDeployment({ entry: "orders", stage: "Prod" }, { root }),
    ).rejects.toThrow('stage "Prod" is not name-safe');
  });

  it("takes an entry name, not a path", async () => {
    await expect(
      loadDeployment({ entry: "infra/api.ts", stage: "prod" }, { root }),
    ).rejects.toThrow('No entry named "infra/api.ts"');
  });
});

describe("loadEntryPoint", () => {
  it("resolves an entry name without a stage", async () => {
    await writeConfig(ordersConfig.replace(`defaultStage: "dev",`, ""));

    await expect(loadEntryPoint("orders", { root })).resolves.toBe(
      path.join(root, "infra/api.ts"),
    );
  });
});
