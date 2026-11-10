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
// package share one class. The package exports each class under its own name.
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
      ? classes
          .map(
            (_, i) =>
              `export const Class${i} = globalThis[${JSON.stringify(key)}][${i}];`,
          )
          .join("\n")
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
      { id: "topic", type: "test/acme/Topic", provider: "@acme/topics" },
      { id: "queue", type: "test/acme/Queue", provider: "@acme/queues" },
      {
        id: "dead-letter",
        type: "test/acme/DeadLetterQueue",
        provider: "@acme/queues",
      },
    ]),
  ).toEqual(["@acme/queues", "@acme/topics"]);
});

it("names no package for a record whose type has a class in code", () => {
  expect(
    stateProviderPackages(
      [{ id: "queue", type: Queue.type, provider: "@acme/uninstalled" }],
      [new Queue("queue")],
    ),
  ).toEqual([]);
});

it("fails on a record with no provider package", () => {
  expect(() =>
    stateProviderPackages(
      [{ id: "queue", type: Queue.type, provider: undefined as any }],
      [new Queue("queue")],
    ),
  ).toThrow("The state record of queue has no provider package");
});

it("registers the resource classes of the packages it resolves from the project root", async () => {
  installPackage("@acme/queues", [Queue]);
  const { registry, failures } = await loadProviderRegistry(
    ["@acme/queues"],
    root,
  );
  expect([...registry]).toEqual([[Queue.type, Queue]]);
  expect(failures).toEqual([]);
});

it("returns a package that exports no resource classes as a failure", async () => {
  installPackage("@acme/empty");
  const { failures } = await loadProviderRegistry(["@acme/empty"], root);
  expect(failures).toEqual([
    expect.objectContaining({
      provider: "@acme/empty",
      errorMessage: "@acme/empty exports no resource classes",
    }),
  ]);
});

it("registers the classes of a subpath that exports namespaces of resource classes", async () => {
  installPackage("@acme/queues");
  const packageDir = path.join(root, "node_modules", "@acme", "queues");
  fs.writeFileSync(
    path.join(packageDir, "package.json"),
    JSON.stringify({
      name: "@acme/queues",
      type: "module",
      exports: {
        "./resources": {
          import: "./dist/resources.js",
          default: "./dist/resources.js",
        },
      },
    }),
  );
  (globalThis as any)["__notationTestClasses:@acme/queues"] = [Queue];
  fs.writeFileSync(
    path.join(packageDir, "dist", "resources.js"),
    'export const sqs = { Queue: globalThis["__notationTestClasses:@acme/queues"][0] };',
  );
  const { registry, failures } = await loadProviderRegistry(
    ["@acme/queues/resources"],
    root,
  );
  expect([...registry]).toEqual([[Queue.type, Queue]]);
  expect(failures).toEqual([]);
});

it("does not import a provider that is a path", async () => {
  const { failures } = await loadProviderRegistry(
    ["./queues", "/tmp/queues", "@acme/queues/../file", "queues/.hidden"],
    root,
  );
  expect(failures.map((failure) => failure.errorMessage)).toEqual([
    "./queues is not a package name or subpath",
    "/tmp/queues is not a package name or subpath",
    "@acme/queues/../file is not a package name or subpath",
    "queues/.hidden is not a package name or subpath",
  ]);
});

it("registers the classes that a CommonJS package exports under default", async () => {
  installPackage("@acme/queues", [Queue]);
  const packageDir = path.join(root, "node_modules", "@acme", "queues");
  fs.writeFileSync(
    path.join(packageDir, "package.json"),
    JSON.stringify({ name: "@acme/queues", main: "./dist/index.cjs" }),
  );
  fs.writeFileSync(
    path.join(packageDir, "dist", "index.cjs"),
    'module.exports = { sqs: { Queue: globalThis["__notationTestClasses:@acme/queues"][0] } };',
  );
  const { registry, failures } = await loadProviderRegistry(
    ["@acme/queues"],
    root,
  );
  expect([...registry]).toEqual([[Queue.type, Queue]]);
  expect(failures).toEqual([]);
});

it("names the cause when a package has no export for the require conditions", async () => {
  installPackage("@acme/queues", [Queue]);
  fs.writeFileSync(
    path.join(root, "node_modules", "@acme", "queues", "package.json"),
    JSON.stringify({
      name: "@acme/queues",
      type: "module",
      exports: { ".": { import: "./dist/index.js" } },
    }),
  );
  const { failures } = await loadProviderRegistry(["@acme/queues"], root);
  expect(failures).toEqual([
    expect.objectContaining({
      provider: "@acme/queues",
      errorMessage: expect.stringMatching(
        /Could not resolve @acme\/queues .*: No "exports" main defined/,
      ),
    }),
  ]);
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

it("walks the dependency tree from the package.json above a project root that has none", async () => {
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
  const infra = path.join(root, "infra");
  fs.mkdirSync(infra);

  const { registry, failures } = await loadProviderRegistry(
    ["@acme/queues"],
    infra,
  );
  expect([...registry]).toEqual([[Queue.type, Queue]]);
  expect(failures).toEqual([]);
});

it("resolves a package two levels down the project's dependency tree, as pnpm installs it", async () => {
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ dependencies: { "@acme/sdk": "1.0.0" } }),
  );
  const pnpm = path.join(root, "node_modules", ".pnpm");
  const sdkStore = path.join(pnpm, "acme+sdk", "node_modules");
  const coreStore = path.join(pnpm, "acme+core", "node_modules");
  installPackage("@acme/sdk", undefined, sdkStore);
  installPackage("@acme/core", undefined, coreStore);
  installPackage("@acme/queues", [Queue], coreStore);
  const sdkManifest = path.join(sdkStore, "@acme", "sdk", "package.json");
  fs.writeFileSync(
    sdkManifest,
    JSON.stringify({
      ...JSON.parse(fs.readFileSync(sdkManifest, "utf8")),
      dependencies: { "@acme/core": "1.0.0" },
    }),
  );
  const coreManifest = path.join(coreStore, "@acme", "core", "package.json");
  fs.writeFileSync(
    coreManifest,
    JSON.stringify({
      ...JSON.parse(fs.readFileSync(coreManifest, "utf8")),
      dependencies: { "@acme/queues": "1.0.0" },
    }),
  );
  fs.symlinkSync(
    path.join(coreStore, "@acme", "core"),
    path.join(sdkStore, "@acme", "core"),
  );
  fs.mkdirSync(path.join(root, "node_modules", "@acme"), { recursive: true });
  fs.symlinkSync(
    path.join(sdkStore, "@acme", "sdk"),
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
    ["@notation/aws/resources", "@notation/std/resources"],
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
