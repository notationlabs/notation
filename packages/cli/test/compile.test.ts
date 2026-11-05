import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setConfigFile } from "@notation/core";
import { compileInfra, compileRuntimeModules } from "../src/compile";

// Inside the repository, so the bundle's imports of @notation packages
// resolve from the root node_modules.
const tmpDir = fileURLToPath(new URL("../../../tmp", import.meta.url));

let root: string;

beforeEach(() => {
  mkdirSync(tmpDir, { recursive: true });
  root = realpathSync(mkdtempSync(path.join(tmpDir, "notation-compile-")));
  mkdirSync(path.join(root, "infra"));
  writeFileSync(path.join(root, "notation.config.ts"), "export default {}");
  setConfigFile(path.join(root, "notation.config.ts"));
});

afterEach(() => {
  setConfigFile(undefined);
  rmSync(root, { recursive: true, force: true });
});

it("reports a declaration error at the line of the user's source", async () => {
  const entryPoint = path.join(root, "infra/main.ts");
  writeFileSync(
    entryPoint,
    [
      `import { fs } from "@notation/std.iac";`,
      ``,
      `type Config = { filePath: string };`,
      `const config = { filePath: 42 } as unknown as Config;`,
      ``,
      `new fs.File("bad-file", { config });`,
      ``,
    ].join("\n"),
  );
  await compileInfra(entryPoint);

  const script = `
    process.setSourceMapsEnabled(true);
    try {
      await import(${JSON.stringify(path.join(root, "dist/infra/main.mjs"))});
    } catch (error) {
      console.log(error.declaredAt);
    }
  `;
  const declaredAt = execFileSync(
    process.execPath,
    ["--input-type=module", "-e", script],
    { cwd: root, encoding: "utf8" },
  ).trim();

  expect(declaredAt).toBe("infra/main.ts:6");
});

const write = (file: string, contents: string) => {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), contents);
};

const todos = `
  export const getTodos = (event: unknown) => ["todos", event];
  export const createTodo = () => "created";
  export const resource = { service: "aws/lambda", id: "todos", timeout: 5 };
`;

describe("runtime modules", () => {
  it("returns the runtime modules that the infra build replaced", async () => {
    write(
      "infra/main.ts",
      [
        `import { getTodos } from "../runtime/todos.fn";`,
        `import { util } from "../runtime/utils.fn";`,
        `import { createTodo } from "../runtime/jobs";`,
        `console.log(getTodos, util, createTodo);`,
      ].join("\n"),
    );
    write("runtime/todos.fn.ts", todos);
    write("runtime/utils.fn.ts", `export const util = 1;`);
    write("runtime/jobs.ts", todos.replace(`"todos"`, `"jobs"`));
    write("runtime/unused.fn.ts", todos.replace(`"todos"`, `"unused"`));
    const entryPoint = path.join(root, "infra/main.ts");

    expect(
      await compileInfra(entryPoint, { runtimeModules: ["**/*.fn.ts"] }),
    ).toEqual([
      { path: path.join(root, "runtime/todos.fn.ts"), service: "aws/lambda" },
    ]);
    expect(
      await compileInfra(entryPoint, { runtimeModules: ["runtime/**"] }),
    ).toEqual([
      { path: path.join(root, "runtime/jobs.ts"), service: "aws/lambda" },
      { path: path.join(root, "runtime/todos.fn.ts"), service: "aws/lambda" },
    ]);
  });

  it("fails for a matching module that exports config", async () => {
    write(
      "infra/main.ts",
      `import { getTodos } from "../runtime/todos.fn";\nconsole.log(getTodos);\n`,
    );
    write(
      "runtime/todos.fn.ts",
      `export const getTodos = () => [];\nexport const config = { service: "aws/lambda", id: "todos" };`,
    );

    await expect(
      compileInfra(path.join(root, "infra/main.ts")),
    ).rejects.toThrow(
      'runtime/todos.fn.ts: rename the "config" export to "resource"',
    );
  });

  it("bundles a runtime module behind a dispatching handler", async () => {
    // Stands in for the service's runtime package.
    write(
      "node_modules/@notation/aws/package.json",
      JSON.stringify({
        name: "@notation/aws",
        type: "module",
        exports: { "./lambda/runtime": "./lambda-runtime.js" },
      }),
    );
    write(
      "node_modules/@notation/aws/lambda-runtime.js",
      `export const createDispatcher = (mod) => (event) => mod[event.export](event);`,
    );
    write("runtime/todos.fn.ts", todos);
    write(
      "infra/main.ts",
      `import { getTodos } from "../runtime/todos.fn";\nconsole.log(getTodos);\n`,
    );

    await compileRuntimeModules(
      await compileInfra(path.join(root, "infra/main.ts")),
    );

    const bundle = path.join(root, "dist/runtime/todos.fn/index.mjs");
    const { handler } = await import(pathToFileURL(bundle).href);
    expect(handler({ export: "getTodos" })).toEqual([
      "todos",
      { export: "getTodos" },
    ]);
    expect(handler({ export: "createTodo" })).toBe("created");
  });

  it("replaces runtime modules in the infra bundle", async () => {
    write(
      "infra/main.ts",
      `import { getTodos } from "../runtime/todos";\nconsole.log(getTodos);\n`,
    );
    write("runtime/todos.ts", `console.log("init");\n${todos}`);

    await compileInfra(path.join(root, "infra/main.ts"), {
      runtimeModules: ["runtime/**"],
    });

    const bundle = readFileSync(path.join(root, "dist/infra/main.mjs"), "utf8");
    expect(bundle).toContain(`from "@notation/aws/lambda"`);
    expect(bundle).toContain(`"id": "todos"`);
    expect(bundle).toContain(`"path": "dist/runtime/todos/index.mjs"`);
    expect(bundle).not.toContain("init");
  });
});
