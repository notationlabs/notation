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
import { compile, compileInfra } from "../src/compile";
import type { Logger } from "../src/logger";

// Inside this package, so the project's imports of @notation/aws resolve
// from the package's node_modules, to the built package.
const tmpDir = fileURLToPath(new URL("../tmp", import.meta.url));
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

const runtimeModule = (id: string) => `
import { lambda } from "@notation/aws/lambda" with { type: "infra" };
const { handle } = lambda({ id: "${id}" });
export const run = handle.apiRequest(() => ({ statusCode: 200, body: "${id}" }));
`;

const importRun = (file: string, name = "run") =>
  `import { run as ${name} } from "${file}" with { type: "runtime" };`;

const names = (modules: string[]) =>
  modules.map((module) => path.basename(module));

const waitFor = (check: () => void) =>
  vi.waitFor(check, { timeout: 10000, interval: 50 });

it("reports the runtime modules after each rebuild", async () => {
  write("watch-a/todos.fn.ts", runtimeModule("todos-a"));
  write("watch-a/jobs.fn.ts", runtimeModule("jobs-a"));
  write("watch-a/main.ts", `${importRun("./todos.fn")}\nconsole.log(run);\n`);

  const seen: string[][] = [];
  const initial = await compileInfra(path.join(root, "watch-a/main.ts"), {
    watch: true,
    onRuntimeModules: (modules) => seen.push(modules),
  });
  expect(names(initial)).toEqual(["todos.fn.ts"]);

  // todos.fn.ts does not change, so the rebuild must still report it.
  write(
    "watch-a/main.ts",
    `${importRun("./todos.fn")}\n${importRun("./jobs.fn", "job")}\nconsole.log(run, job);\n`,
  );
  await waitFor(() =>
    expect(names(seen.at(-1)!)).toEqual(["jobs.fn.ts", "todos.fn.ts"]),
  );
});

it("bundles the functions that an infra rebuild adds", async () => {
  write("watch-b/todos.fn.ts", runtimeModule("todos-b"));
  write("watch-b/jobs.fn.ts", runtimeModule("jobs-b"));
  write(
    "watch-b/main.ts",
    `import { api, router } from "@notation/aws/api-gateway";\n${importRun("./todos.fn")}\nrouter(api({ name: "b" })).get("/", run);\n`,
  );
  const bundle = (id: string) =>
    path.join(root, `dist/functions/${id}/index.mjs`);

  await compile(build("watch-b/main.ts"), { watch: true, logger });
  await waitFor(() => expect(existsSync(bundle("todos-b"))).toBe(true));
  expect(existsSync(bundle("jobs-b"))).toBe(false);

  write(
    "watch-b/main.ts",
    `import { api, router } from "@notation/aws/api-gateway";\n${importRun("./jobs.fn")}\nrouter(api({ name: "b" })).get("/", run);\n`,
  );
  await waitFor(() => expect(existsSync(bundle("jobs-b"))).toBe(true));
});

it("waits for a build that succeeds, and says so", async () => {
  write("watch-c/todos.fn.ts", runtimeModule("todos-c"));
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

  write("watch-c/main.ts", `${importRun("./todos.fn")}\nconsole.log(run);\n`);
  await compiling;
});
