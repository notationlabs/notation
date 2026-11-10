import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SqliteRuntime, createSqliteDb } from "@notation/durable/sqlite/node";
import type { ReconcilerEvent } from "@notation/reconciler";
import {
  DurableStateBackend,
  resourceStateStore,
} from "@notation/reconciler/durable";
import { resource, type BaseResource } from "@notation/resource";
import { resolveDeploymentId } from "src/config/deployment";
import { deployApp } from "src/provisioner";
import {
  loadProviderRegistry,
  stateProviderPackages,
} from "src/provisioner/resource-registry";
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

const deleted = vi.fn((_type: string) => undefined);
const defineQueue = (type: string, provider: string) =>
  resource({ type: type as `${string}/${string}/${string}`, provider })
    .defineSchema({})
    .defineOperations({
      create: async () => undefined,
      delete: async () => void deleted(type),
    });

const Queue = defineQueue("test/acme/Queue", "@acme/queues");

const deployment = {
  app: "orders",
  stage: "prod",
  entryPoint: "",
  files: {},
};

let root: string;
let databasePath: string;
let events: ReconcilerEvent[];

// Each package reads its classes from a global, so that the test and the
// package share one class.
function installPackage(
  name: string,
  classes?: unknown[],
  nodeModules = path.join(root, "node_modules"),
) {
  const packageDir = path.join(nodeModules, ...name.split("/"));
  fs.mkdirSync(path.join(packageDir, "dist"), { recursive: true });
  fs.writeFileSync(
    path.join(packageDir, "package.json"),
    JSON.stringify({
      name,
      type: "module",
      exports: {
        ".": {
          types: "./dist/index.d.ts",
          import: "./dist/index.js",
          default: "./dist/index.js",
        },
      },
    }),
  );
  const key = `__notationTestClasses:${name}`;
  (globalThis as any)[key] = classes;
  fs.writeFileSync(
    path.join(packageDir, "dist", "index.js"),
    classes
      ? `export const resourceClasses = globalThis[${JSON.stringify(key)}];`
      : "export const other = 1;",
  );
}

function deploy(executionId: string) {
  return deployApp({
    deployment,
    databasePath,
    executionId,
    emit: (event) => void events.push(event),
  });
}

async function withState<T>(
  fn: (state: DurableStateBackend, runtime: SqliteRuntime) => Promise<T>,
): Promise<T> {
  const database = createSqliteDb({ path: databasePath });
  try {
    const runtime = new SqliteRuntime(database);
    const state = new DurableStateBackend(
      runtime.stores,
      resolveDeploymentId(deployment),
    );
    return await fn(state, runtime);
  } finally {
    database.close();
  }
}

function setProvider(id: string, provider: string) {
  return withState(async (state, runtime) => {
    const store = runtime.stores.store(resourceStateStore, state.storeId(id));
    const { state: record } = await store.get();
    await store.update(() => ({ ...record!, provider }));
  });
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "notation-providers-"));
  fs.writeFileSync(path.join(root, "notation.config.ts"), "");
  deployment.entryPoint = path.join(root, "infra.ts");
  databasePath = path.join(root, "workflows.db");
  events = [];
  setConfigFile(path.join(root, "notation.config.ts"));
  deleted.mockClear();
});

afterEach(async () => {
  setConfigFile(undefined);
  for (const key of Object.keys(globalThis)) {
    if (key.startsWith("__notationTestClasses:")) {
      delete (globalThis as any)[key];
    }
  }
  await rm(root, { recursive: true, force: true });
});

it("names the provider of each record once, sorted", () => {
  expect(
    stateProviderPackages([
      { type: "test/acme/Topic", provider: "@acme/topics" },
      { type: "test/acme/Queue", provider: "@acme/queues" },
      { type: "test/acme/DeadLetterQueue", provider: "@acme/queues" },
    ]),
  ).toEqual(["@acme/queues", "@acme/topics"]);
});

it("names no package for a record whose type has a class in code", () => {
  expect(
    stateProviderPackages(
      [{ type: Queue.type, provider: "@acme/uninstalled" }],
      [new Queue("queue")],
    ),
  ).toEqual([]);
});

it("registers the resource classes of the packages it resolves from the project root", async () => {
  installPackage("@acme/queues", [Queue]);
  installPackage("@acme/empty");
  const { registry, failures } = await loadProviderRegistry(
    ["@acme/queues", "@acme/empty"],
    root,
  );
  expect([...registry]).toEqual([[Queue.type, Queue]]);
  expect(failures).toEqual([]);
});

it("returns a package that it can't resolve as a failure, and skips it", async () => {
  const { registry, failures } = await loadProviderRegistry(
    ["@acme/missing"],
    root,
  );
  expect([...registry]).toEqual([]);
  expect(failures).toEqual([
    expect.objectContaining({
      provider: "@acme/missing",
      errorMessage: expect.stringContaining("Could not resolve @acme/missing"),
    }),
  ]);
});

it("returns a package that throws on import as a failure, and loads the others", async () => {
  installPackage("@acme/queues", [Queue]);
  installPackage("@acme/broken");
  fs.writeFileSync(
    path.join(root, "node_modules", "@acme", "broken", "dist", "index.js"),
    'throw new Error("broken on import");',
  );
  const { registry, failures } = await loadProviderRegistry(
    ["@acme/broken", "@acme/queues"],
    root,
  );
  expect([...registry]).toEqual([[Queue.type, Queue]]);
  expect(failures).toEqual([
    {
      level: "warn",
      event: "reconciler.provider.load-failed",
      provider: "@acme/broken",
      errorMessage: "broken on import",
    },
  ]);
});

// pnpm links only the project's own dependencies into its node_modules. A
// dependency's dependencies sit next to it in the store.
it("resolves a package that the project depends on through another package, as pnpm installs it", async () => {
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ dependencies: { "@acme/sdk": "1.0.0" } }),
  );
  const store = path.join(
    root,
    "node_modules",
    ".pnpm",
    "acme+sdk",
    "node_modules",
  );
  installPackage("@acme/sdk", undefined, store);
  installPackage("@acme/queues", [Queue], store);
  fs.mkdirSync(path.join(root, "node_modules", "@acme"), { recursive: true });
  fs.symlinkSync(
    path.join(store, "@acme", "sdk"),
    path.join(root, "node_modules", "@acme", "sdk"),
  );

  const { registry, failures } = await loadProviderRegistry(
    ["@acme/queues"],
    root,
  );
  expect([...registry]).toEqual([[Queue.type, Queue]]);
  expect(failures).toEqual([]);
});

it("resolves the workspace's own provider packages from the repository root", async () => {
  const repoRoot = path.resolve(import.meta.dirname, "../../../..");
  const { registry } = await loadProviderRegistry(
    ["@notation/aws.iac", "@notation/std.iac"],
    repoRoot,
  );
  expect(registry.has("aws/sqs/Queue")).toBe(true);
  expect(registry.has("std/fs/Zip")).toBe(true);
});

it("records the provider package in each state record", async () => {
  installPackage("@acme/queues", [Queue]);
  graph.resources = [new Queue("queue")];
  await deploy("deploy-1");

  const record = await withState((state) => state.get("queue"));
  expect(record).toMatchObject({ type: Queue.type, provider: "@acme/queues" });
});

it("deletes an orphan whose type is absent from the graph through the provider its record names", async () => {
  installPackage("@acme/queues", [Queue]);
  graph.resources = [new Queue("queue")];
  await deploy("deploy-1");
  graph.resources = [];
  await deploy("deploy-2");

  expect(deleted.mock.calls).toEqual([[Queue.type]]);
  expect(await withState((state) => state.values())).toEqual([]);
});

it("skips an orphan whose provider package is not installed, with a warning", async () => {
  installPackage("@acme/queues", [Queue]);
  graph.resources = [new Queue("queue")];
  await deploy("deploy-1");
  await setProvider("queue", "@acme/uninstalled");
  graph.resources = [];
  await deploy("deploy-2");

  expect(deleted).not.toHaveBeenCalled();
  expect(events).toContainEqual(
    expect.objectContaining({
      event: "reconciler.provider.load-failed",
      provider: "@acme/uninstalled",
    }),
  );
  expect(events).toContainEqual(
    expect.objectContaining({
      event: "reconciler.orphan-deletion.skipped",
      resourceId: "queue",
    }),
  );
});

it("loads no provider package, and warns of none, when every record's type has a class in code", async () => {
  installPackage("@acme/queues", [Queue]);
  graph.resources = [new Queue("queue")];
  await deploy("deploy-1");
  await setProvider("queue", "@acme/uninstalled");
  await deploy("deploy-2");

  expect(events.map((event) => event.event)).not.toContain(
    "reconciler.provider.load-failed",
  );
});
