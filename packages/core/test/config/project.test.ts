import {
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadProject } from "src/config/project";
import { resolveDeployment, resolveEntryPoint } from "src/config/deployment";

const originalCwd = process.cwd();
const corePackage = path.resolve(import.meta.dirname, "../..");
let root: string;

// The project links @notation/core, so the config's import resolves as it
// does in an app.
beforeEach(async () => {
  root = await realpath(
    await mkdtemp(path.join(tmpdir(), "notation-project-")),
  );
  await writeFile(path.join(root, "package.json"), "{}");
  await mkdir(path.join(root, "node_modules/@notation"), { recursive: true });
  await symlink(corePackage, path.join(root, "node_modules/@notation/core"));
  process.chdir(root);
});

afterEach(async () => {
  process.chdir(originalCwd);
  await rm(root, { recursive: true, force: true });
});

function writeConfig(source: string) {
  return writeFile(path.join(root, "notation.config.ts"), source);
}

const ordersConfig = `
import { defineConfig } from "@notation/core/config";

export default defineConfig({
  app: "orders-app",
  entries: { orders: "infra/api.ts" },
  runtimeModules: "src/**/*.fn.ts",
  defaultStage: "dev",
});
`;

describe("loadProject", () => {
  it("loads notation.config.ts from the project root", async () => {
    await writeConfig(ordersConfig);

    await expect(loadProject()).resolves.toEqual({
      root,
      config: {
        app: "orders-app",
        entries: { orders: "infra/api.ts" },
        runtimeModules: "src/**/*.fn.ts",
        defaultStage: "dev",
      },
    });
  });

  it("finds the project root from a subdirectory", async () => {
    await writeConfig(ordersConfig);
    await mkdir(path.join(root, "infra"));
    process.chdir(path.join(root, "infra"));

    await expect(loadProject()).resolves.toMatchObject({ root });
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

    await expect(loadProject()).resolves.toMatchObject({
      config: { app: "orders-app" },
    });
  });

  it("reads the config again after it changes", async () => {
    await writeConfig(ordersConfig);
    await loadProject();
    await writeConfig(ordersConfig.replace("orders-app", "billing-app"));

    await expect(loadProject()).resolves.toMatchObject({
      config: { app: "billing-app" },
    });
  });

  // Watch redeploys on any change in dist, so a bundle there would redeploy
  // on every deploy.
  it("writes nothing to dist and deletes its bundle", async () => {
    await writeConfig(ordersConfig);

    await loadProject();

    await expect(readdir(path.join(root, "dist"))).rejects.toThrow("ENOENT");
    await expect(
      readdir(path.join(root, "node_modules/.cache/notation")),
    ).resolves.toEqual([]);
  });

  it("loads the config in parallel", async () => {
    await writeConfig(ordersConfig);

    const projects = await Promise.all(
      Array.from({ length: 5 }, () => loadProject()),
    );

    for (const project of projects) {
      expect(project.config.app).toBe("orders-app");
    }
  });

  it("deletes its bundle when the config fails to load", async () => {
    await writeConfig(`export default { app: "Orders_App" };`);

    await expect(loadProject()).rejects.toThrow();
    await expect(
      readdir(path.join(root, "node_modules/.cache/notation")),
    ).resolves.toEqual([]);
  });

  it("fails when the project has no config", async () => {
    await expect(loadProject()).rejects.toThrow(
      `No notation.config.ts found in ${root}`,
    );
  });

  it("checks names at runtime", async () => {
    await writeConfig(`
      export default { app: "Orders_App", entries: { orders: "infra/api.ts" } };
    `);

    await expect(loadProject()).rejects.toThrow(
      'app "Orders_App" is not name-safe',
    );
  });
});

describe("resolving a loaded project", () => {
  beforeEach(() => writeConfig(ordersConfig));

  it("resolves entries against the project root", async () => {
    await mkdir(path.join(root, "infra"));
    await writeFile(path.join(root, "infra/api.ts"), "");
    process.chdir(path.join(root, "infra"));
    const project = await loadProject();

    expect(resolveEntryPoint(project, "orders")).toBe(
      path.join(root, "infra/api.ts"),
    );
    expect(
      resolveDeployment(project, { entry: "orders", stage: "prod" }),
    ).toEqual({
      app: "orders-app",
      stage: "prod",
      entry: "orders",
      entryPoint: path.join(root, "infra/api.ts"),
    });
  });
});
