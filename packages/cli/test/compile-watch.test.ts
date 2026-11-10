import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it, onTestFinished, vi } from "vitest";
import { ModuleAnalyses } from "@notation/build";
import { setConfigFile } from "@notation/core";
import { compile, compileInfra, type DeclarationModule } from "../src/compile";
import type { Logger } from "../src/logger";

// Inside the repository, so the bundle's imports of @notation packages
// resolve from the root node_modules.
const tmpDir = fileURLToPath(new URL("../../../tmp", import.meta.url));
const logger = { info: () => {}, error: () => {} } as unknown as Logger;

let root: string;

beforeAll(() => {
  mkdirSync(tmpDir, { recursive: true });
  root = realpathSync(mkdtempSync(path.join(tmpDir, "notation-watch-")));
  writeFileSync(path.join(root, "notation.config.ts"), "export default {}");
  setConfigFile(path.join(root, "notation.config.ts"));
});

afterAll(async () => {
  setConfigFile(undefined);
  rmSync(root, { recursive: true, force: true });
});

const build = (entry: string, runtime: string[] = []) => ({
  entryPoint: path.join(root, entry),
  files: { runtime },
});

const write = (file: string, contents: string) => {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), contents);
};

// A declaration module with its own marked declaration function, so the
// project needs no package.
const runtimeModule = (id: string) =>
  [
    `/** @declaration entry: handler */`,
    `function declare(config) { return config; }`,
    `export const fn = declare({ id: "${id}" });`,
    `export const handler = () => "${id}";`,
    ``,
  ].join("\n");

const names = (modules: DeclarationModule[]) =>
  modules.map((module) => path.basename(module.path));

const waitFor = (check: () => void) =>
  vi.waitFor(check, { timeout: 5000, interval: 50 });

it("reports the declaration modules after each rebuild", async () => {
  write("watch-a/todos.ts", runtimeModule("todos"));
  write("watch-a/jobs.ts", runtimeModule("jobs"));
  write("watch-a/main.ts", `import { fn } from "./todos";\nconsole.log(fn);\n`);

  const seen: DeclarationModule[][] = [];
  const initial = await compileInfra(path.join(root, "watch-a/main.ts"), {
    watch: true,
    onDeclarationModules: (modules) => seen.push(modules),
  });
  onTestFinished(initial.close);
  expect(names(initial.modules)).toEqual(["todos.ts"]);

  // todos.ts does not change, so the rebuild must still report it.
  write(
    "watch-a/main.ts",
    `import { fn } from "./todos";\nimport { fn as job } from "./jobs";\nconsole.log(fn, job);\n`,
  );
  await waitFor(() =>
    expect(names(seen.at(-1)!)).toEqual(["jobs.ts", "todos.ts"]),
  );
});

it("bundles the runtime modules that an infra rebuild adds", async () => {
  write("watch-b/todos.ts", runtimeModule("todos"));
  write("watch-b/jobs.ts", runtimeModule("jobs"));
  write("watch-b/main.ts", `import { fn } from "./todos";\nconsole.log(fn);\n`);
  const bundle = (name: string) =>
    path.join(root, `dist/watch-b/${name}/index.mjs`);

  onTestFinished(
    await compile(build("watch-b/main.ts"), { watch: true, logger }),
  );
  await waitFor(() => expect(existsSync(bundle("todos"))).toBe(true));
  expect(existsSync(bundle("jobs"))).toBe(false);

  write("watch-b/main.ts", `import { fn } from "./jobs";\nconsole.log(fn);\n`);
  await waitFor(() => expect(existsSync(bundle("jobs"))).toBe(true));
});

it("waits for a build that succeeds, and says so", async () => {
  write("watch-c/todos.ts", runtimeModule("todos"));
  write("watch-c/main.ts", `export const broken = ;\n`);
  const info = vi.fn();
  const watchLogger = { info, error: () => {} } as unknown as Logger;

  let resolved = false;
  const compiling = compile(build("watch-c/main.ts"), {
    watch: true,
    logger: watchLogger,
  }).then((close) => {
    resolved = true;
    onTestFinished(close);
  });

  await waitFor(() =>
    expect(info).toHaveBeenCalledWith(
      expect.stringContaining("The infrastructure build failed"),
    ),
  );
  expect(resolved).toBe(false);

  write("watch-c/main.ts", `import { fn } from "./todos";\nconsole.log(fn);\n`);
  await compiling;
});

it("stops rebuilding after close", async () => {
  write("watch-d/todos.ts", runtimeModule("todos"));
  write("watch-d/jobs.ts", runtimeModule("jobs"));
  write("watch-d/main.ts", `import { fn } from "./todos";\nconsole.log(fn);\n`);
  const bundle = (name: string) =>
    path.join(root, `dist/watch-d/${name}/index.mjs`);

  const close = await compile(build("watch-d/main.ts"), {
    watch: true,
    logger,
  });
  await waitFor(() => expect(existsSync(bundle("todos"))).toBe(true));
  await close();

  write("watch-d/main.ts", `import { fn } from "./jobs";\nconsole.log(fn);\n`);
  await new Promise((resolve) => setTimeout(resolve, 1000));
  expect(existsSync(bundle("jobs"))).toBe(false);
});

it("bundles a runtime file that is created during watch", async () => {
  write("watch-e/runtime/todos.ts", runtimeModule("todos"));
  write(
    "watch-e/main.ts",
    `import { fn } from "./runtime/todos";\nconsole.log(fn);\n`,
  );
  const bundle = (name: string) =>
    path.join(root, `dist/watch-e/runtime/${name}/index.mjs`);

  onTestFinished(
    await compile(build("watch-e/main.ts", ["watch-e/runtime/**/*.ts"]), {
      watch: true,
      logger,
    }),
  );
  await waitFor(() => expect(existsSync(bundle("todos"))).toBe(true));

  write("watch-e/runtime/jobs/nightly.ts", runtimeModule("nightly"));
  await waitFor(() => expect(existsSync(bundle("jobs/nightly"))).toBe(true));
});

it("doesn't rebuild on build output, packages or deploy state when a glob covers the project root", async () => {
  write("watch-f/todos.ts", runtimeModule("todos"));
  write("watch-f/main.ts", `import { fn } from "./todos";\nconsole.log(fn);\n`);

  let builds = 0;
  const infra = await compileInfra(path.join(root, "watch-f/main.ts"), {
    watch: true,
    analyses: new ModuleAnalyses({ files: { runtime: ["**/*.ts"] } }),
    onDeclarationModules: () => builds++,
  });
  onTestFinished(infra.close);
  const wait = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));

  // macOS can report the files written above after the watcher starts,
  // which starts one more build.
  await wait(500);
  const settled = builds;
  write(".notation/workflows.db", "state");
  write("packages/app/dist/index.js", "built");
  write("packages/app/node_modules/dep/index.js", "installed");
  await wait(1000);
  expect(builds).toBe(settled);
});

it("watches only the folder of a runtime glob with no glob characters", async () => {
  write("watch-k/jobs/nightly.ts", runtimeModule("nightly"));
  write("watch-k/main.ts", `console.log("no imports");\n`);

  let builds = 0;
  const infra = await compileInfra(path.join(root, "watch-k/main.ts"), {
    watch: true,
    analyses: new ModuleAnalyses({ files: { runtime: ["watch-k/jobs"] } }),
    onDeclarationModules: () => builds++,
  });
  onTestFinished(infra.close);
  const wait = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));

  await wait(500);
  const settled = builds;
  write("watch-k/notes/readme.md", "notes");
  await wait(1000);
  expect(builds).toBe(settled);

  write("watch-k/jobs/weekly.ts", runtimeModule("weekly"));
  await waitFor(() => expect(builds).toBeGreaterThan(settled));
});

it("bundles a runtime file in a glob directory that is created during watch", async () => {
  write("watch-g/main.ts", `console.log("no imports");\n`);
  const bundle = path.join(root, "dist/watch-g/runtime/todos/index.mjs");

  onTestFinished(
    await compile(build("watch-g/main.ts", ["watch-g/runtime/**/*.ts"]), {
      watch: true,
      logger,
    }),
  );

  // Lets the rebuild from macOS's late report of main.ts pass first, so
  // that only the watch on watch-g/ can start the next one.
  await new Promise((resolve) => setTimeout(resolve, 500));
  write("watch-g/runtime/todos.ts", runtimeModule("todos"));
  await waitFor(() => expect(existsSync(bundle)).toBe(true));
});

it("checks a shared module again when a module that it imports changes", async () => {
  write("watch-i/infra/orders.ts", `export const orders = { url: "u" };\n`);
  write("watch-i/lib/util.ts", `export const util = () => "util";\n`);
  write(
    "watch-i/shared/schema.ts",
    `import { util } from "../lib/util";\nexport const Order = { util };\n`,
  );
  write(
    "watch-i/main.ts",
    `import { Order } from "./shared/schema";\nconsole.log(Order);\n`,
  );
  const errors: unknown[] = [];
  onTestFinished(
    await compile(
      {
        entryPoint: path.join(root, "watch-i/main.ts"),
        files: {
          infra: ["watch-i/infra/**"],
          runtime: [],
          shared: ["watch-i/shared/**"],
        },
      },
      {
        watch: true,
        logger: { ...logger, error: (error: unknown) => errors.push(error) },
      },
    ),
  );
  expect(errors).toEqual([]);

  write(
    "watch-i/lib/util.ts",
    `import { orders } from "../infra/orders";\nexport const util = () => orders.url;\n`,
  );
  await waitFor(() =>
    expect(String(errors.at(-1))).toContain(
      "through watch-i/shared/schema.ts:1:1 → watch-i/lib/util.ts:1:1 → watch-i/infra/orders.ts.",
    ),
  );
});

it("fails each build that includes a broken shared module, and writes no bundle", async () => {
  write("watch-j/infra/orders.ts", `export const orders = { url: "u" };\n`);
  write("watch-j/lib/util.ts", `export const util = () => "util";\n`);
  write(
    "watch-j/shared/schema.ts",
    `import { util } from "../lib/util";\nexport const Order = { util };\n`,
  );
  for (const id of ["todos", "jobs"]) {
    write(
      `watch-j/${id}.ts`,
      `import { Order } from "./shared/schema";\n${runtimeModule(id).replace(`() => "${id}"`, "() => Order")}`,
    );
  }
  write(
    "watch-j/main.ts",
    `import { fn } from "./todos";\nimport { fn as job } from "./jobs";\nimport { Order } from "./shared/schema";\nconsole.log(fn, job, Order);\n`,
  );
  const bundle = (id: string) =>
    path.join(root, `dist/watch-j/${id}/index.mjs`);
  const errors: unknown[] = [];
  onTestFinished(
    await compile(
      {
        entryPoint: path.join(root, "watch-j/main.ts"),
        files: {
          infra: ["watch-j/infra/**"],
          runtime: [],
          shared: ["watch-j/shared/**"],
        },
      },
      {
        watch: true,
        logger: { ...logger, error: (error: unknown) => errors.push(error) },
      },
    ),
  );
  await waitFor(() => {
    expect(existsSync(bundle("todos"))).toBe(true);
    expect(existsSync(bundle("jobs"))).toBe(true);
  });
  expect(errors).toEqual([]);
  const before = {
    todos: readFileSync(bundle("todos"), "utf8"),
    jobs: readFileSync(bundle("jobs"), "utf8"),
  };

  write(
    "watch-j/lib/util.ts",
    `import { orders } from "../infra/orders";\nexport const util = () => orders.url;\n`,
  );
  const reports = () =>
    errors.filter((error) =>
      String(error).includes("watch-j/shared/schema.ts, a shared module"),
    );
  // The infra build and both runtime builds fail.
  await waitFor(() => expect(reports().length).toBeGreaterThanOrEqual(3));
  await new Promise((resolve) => setTimeout(resolve, 1000));
  expect(readFileSync(bundle("todos"), "utf8")).toBe(before.todos);
  expect(readFileSync(bundle("jobs"), "utf8")).toBe(before.jobs);
}, 15000);

// Last, because the default globs read runtime/ at the root, which the
// other tests don't use.
it("bundles a file that is added under runtime/ with the default globs", async () => {
  write("watch-h/main.ts", `console.log("no imports");\n`);
  const bundle = path.join(root, "dist/runtime/added/index.mjs");
  onTestFinished(
    await compile(
      { entryPoint: path.join(root, "watch-h/main.ts"), files: {} },
      { watch: true, logger },
    ),
  );
  await new Promise((resolve) => setTimeout(resolve, 500));
  write("runtime/added.ts", runtimeModule("added"));
  await waitFor(() => expect(existsSync(bundle)).toBe(true));
});

it("bundles a module when a rebuild gives its declaration an entry", async () => {
  const module = (clause: string) =>
    [
      `/** @declaration ${clause} */`,
      `function declare(config) { return config; }`,
      `export const fn = declare({ id: "counters" });`,
      `export const handler = () => "counters";`,
      ``,
    ].join("\n");
  write("watch-entry/counters.ts", module("shared: id"));
  write(
    "watch-entry/main.ts",
    `import { fn } from "./counters";\nconsole.log(fn);\n`,
  );
  const bundle = path.join(root, "dist/watch-entry/counters/index.mjs");

  onTestFinished(
    await compile(build("watch-entry/main.ts"), { watch: true, logger }),
  );
  expect(existsSync(bundle)).toBe(false);

  write("watch-entry/counters.ts", module("shared: id; entry: handler"));
  await waitFor(() => expect(existsSync(bundle)).toBe(true));
});

it("rebuilds a Worker module that removes an export without an error", async () => {
  const module = (classExport: string) =>
    [
      `/** @declaration shared: id; entry: default; platform: workerd */`,
      `function declare(config) { return config; }`,
      `class Counter {}`,
      classExport,
      `export const worker = declare({ id: "api" });`,
      `export default { fetch: () => new Response("api") };`,
      ``,
    ].join("\n");
  write("watch-exports/api.ts", module("export { Counter };"));
  write(
    "watch-exports/main.ts",
    `import { worker } from "./api";\nconsole.log(worker);\n`,
  );
  const bundle = path.join(root, "dist/watch-exports/api/index.mjs");
  const error = vi.fn();
  const watchLogger = { info: () => {}, error } as unknown as Logger;

  onTestFinished(
    await compile(build("watch-exports/main.ts"), {
      watch: true,
      logger: watchLogger,
    }),
  );
  await waitFor(() =>
    expect(readFileSync(bundle, "utf8")).toContain("Counter"),
  );

  write("watch-exports/api.ts", module(""));
  await waitFor(() =>
    expect(readFileSync(bundle, "utf8")).not.toContain("Counter"),
  );
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect(error).not.toHaveBeenCalled();
});

it("doesn't log an error when a rebuild takes a module's entry away", async () => {
  const withEntry = runtimeModule("jobs");
  const withoutEntry = [
    `/** @declaration shared: id */`,
    `function declare(config) { return config; }`,
    `export const fn = declare({ id: "jobs" });`,
    ``,
  ].join("\n");
  write("watch-entry-loss/jobs.ts", withEntry);
  write(
    "watch-entry-loss/main.ts",
    `import { fn } from "./jobs";\nconsole.log(fn);\n`,
  );
  const bundle = path.join(root, "dist/watch-entry-loss/jobs/index.mjs");
  const error = vi.fn();
  const info = vi.fn();
  const watchLogger = { info, error } as unknown as Logger;

  onTestFinished(
    await compile(build("watch-entry-loss/main.ts"), {
      watch: true,
      logger: watchLogger,
    }),
  );
  await waitFor(() => expect(existsSync(bundle)).toBe(true));

  write("watch-entry-loss/jobs.ts", withoutEntry);
  await new Promise((resolve) => setTimeout(resolve, 1000));
  expect(error).not.toHaveBeenCalled();
});
