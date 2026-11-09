import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resource, type BaseResource } from "@notation/resource";
import { deployApp } from "src/provisioner";
import { loadProviderRegistry } from "src/provisioner/resource-registry";
import { setConfigFile } from "src/utils/paths";

const { graph } = vi.hoisted(() => ({
  graph: { resources: [] as BaseResource[] },
}));

vi.mock("src/orchestrator/graph", () => ({
  getResourceGraph: async () => ({
    resourceGroups: [],
    resources: graph.resources,
  }),
}));

const deleteQueue = vi.fn(async () => undefined);
const Queue = resource({ type: "test/provider/Queue" })
  .defineSchema({})
  .defineOperations({ create: async () => undefined, delete: deleteQueue });

let root: string;

// A project with a provider package installed whose resourceClasses hold
// Queue. The package reads the class from a global, so that the test and
// the package share one class.
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "notation-providers-"));
  fs.writeFileSync(path.join(root, "notation.config.ts"), "");
  const packageDir = path.join(root, "node_modules", "@notation", "aws.iac");
  fs.mkdirSync(path.join(packageDir, "dist"), { recursive: true });
  fs.writeFileSync(
    path.join(packageDir, "package.json"),
    JSON.stringify({
      name: "@notation/aws.iac",
      type: "module",
      exports: {
        ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
      },
    }),
  );
  fs.writeFileSync(
    path.join(packageDir, "dist", "index.js"),
    "export const resourceClasses = globalThis.__notationTestClasses;",
  );
  (globalThis as any).__notationTestClasses = [Queue];
  setConfigFile(path.join(root, "notation.config.ts"));
  deleteQueue.mockClear();
});

afterEach(async () => {
  setConfigFile(undefined);
  delete (globalThis as any).__notationTestClasses;
  await rm(root, { recursive: true, force: true });
});

it("registers the resource classes of the provider packages the project has installed", async () => {
  const registry = await loadProviderRegistry();
  expect([...registry]).toEqual([[Queue.type, Queue]]);
});

it("deploy deletes an orphan whose type is no longer in the graph", async () => {
  const deployment = {
    app: "orders",
    stage: "prod",
    entryPoint: path.join(root, "infra.ts"),
    files: {},
  };
  const databasePath = path.join(root, "workflows.db");
  const run = (executionId: string) =>
    deployApp({ deployment, databasePath, executionId, emit: () => {} });

  graph.resources = [new Queue("queue")];
  await run("deploy-1");
  graph.resources = [];
  await run("deploy-2");

  expect(deleteQueue).toHaveBeenCalledOnce();
});
