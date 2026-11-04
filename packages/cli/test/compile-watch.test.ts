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
import esbuild from "esbuild";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { setConfigFile } from "@notation/core";
import { compile, compileInfra, type RuntimeModuleEntry } from "../src/compile";
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

// Watch mode gives no handle to stop its contexts, so this stops esbuild.
afterAll(async () => {
  await esbuild.stop();
  setConfigFile(undefined);
  rmSync(root, { recursive: true, force: true });
});

const build = (entry: string) => ({
  entryPoint: path.join(root, entry),
  runtimeModules: ["**/*.fn.ts"],
});

const write = (file: string, contents: string) => {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), contents);
};

const runtimeModule = (id: string) =>
  `export const run = () => "${id}";\nexport const resource = { service: "aws/lambda", id: "${id}" };\n`;

const names = (modules: RuntimeModuleEntry[]) =>
  modules.map((module) => path.basename(module.path));

const waitFor = (check: () => void) =>
  vi.waitFor(check, { timeout: 5000, interval: 50 });

it("reports the replaced runtime modules after each rebuild", async () => {
  write("watch-a/todos.fn.ts", runtimeModule("todos"));
  write("watch-a/jobs.fn.ts", runtimeModule("jobs"));
  write(
    "watch-a/main.ts",
    `import { run } from "./todos.fn";\nconsole.log(run);\n`,
  );

  const seen: RuntimeModuleEntry[][] = [];
  const initial = await compileInfra(path.join(root, "watch-a/main.ts"), {
    watch: true,
    onRuntimeModules: (modules) => seen.push(modules),
  });
  expect(names(initial)).toEqual(["todos.fn.ts"]);

  // todos.fn.ts does not change, so the rebuild must still report it.
  write(
    "watch-a/main.ts",
    `import { run } from "./todos.fn";\nimport { run as job } from "./jobs.fn";\nconsole.log(run, job);\n`,
  );
  await waitFor(() =>
    expect(names(seen.at(-1)!)).toEqual(["jobs.fn.ts", "todos.fn.ts"]),
  );
});

it("bundles the runtime modules that an infra rebuild adds", async () => {
  // Stands in for the service's runtime package.
  write(
    "node_modules/@notation/aws/package.json",
    JSON.stringify({
      name: "@notation/aws",
      type: "module",
      exports: { "./lambda.fn": "./lambda.fn.js" },
    }),
  );
  write(
    "node_modules/@notation/aws/lambda.fn.js",
    `export const createDispatcher = (mod) => (event) => mod[event.export](event);`,
  );
  write("watch-b/todos.fn.ts", runtimeModule("todos"));
  write("watch-b/jobs.fn.ts", runtimeModule("jobs"));
  write(
    "watch-b/main.ts",
    `import { run } from "./todos.fn";\nconsole.log(run);\n`,
  );
  const bundle = (name: string) =>
    path.join(root, `dist/watch-b/${name}/index.mjs`);

  await compile(build("watch-b/main.ts"), { watch: true, logger });
  await waitFor(() => expect(existsSync(bundle("todos.fn"))).toBe(true));
  expect(existsSync(bundle("jobs.fn"))).toBe(false);

  write(
    "watch-b/main.ts",
    `import { run } from "./jobs.fn";\nconsole.log(run);\n`,
  );
  await waitFor(() => expect(existsSync(bundle("jobs.fn"))).toBe(true));
});

it("waits for a build that succeeds, and says so", async () => {
  write("watch-c/todos.fn.ts", runtimeModule("todos"));
  write("watch-c/main.ts", `export const broken = ;\n`);
  const info = vi.fn();
  const watchLogger = { info, error: () => {} } as unknown as Logger;

  let resolved = false;
  const compiling = compile(build("watch-c/main.ts"), {
    watch: true,
    logger: watchLogger,
  }).then(() => {
    resolved = true;
  });

  await waitFor(() =>
    expect(info).toHaveBeenCalledWith(
      expect.stringContaining("The infrastructure build failed"),
    ),
  );
  expect(resolved).toBe(false);

  write(
    "watch-c/main.ts",
    `import { run } from "./todos.fn";\nconsole.log(run);\n`,
  );
  await compiling;
});
