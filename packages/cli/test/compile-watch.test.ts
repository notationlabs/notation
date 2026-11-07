import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it, onTestFinished, vi } from "vitest";
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

const build = (entry: string) => ({ entryPoint: path.join(root, entry) });

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
