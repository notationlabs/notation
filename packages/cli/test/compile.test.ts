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
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setConfigFile } from "@notation/core";
import { compileInfra } from "../src/compile";

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
  import { lambda } from "@notation/aws/lambda" with { type: "infra" };
  console.log("init");
  const { handle } = lambda({ id: "todos", timeout: 5 });
  export const getTodos = handle.apiRequest(() => ({ statusCode: 200 }));
`;

describe("runtime modules", () => {
  it("returns the runtime modules that infra imports with type: runtime", async () => {
    write(
      "infra/main.ts",
      [
        `import { getTodos } from "../runtime/todos.fn" with { type: "runtime" };`,
        `import * as jobs from "../runtime/jobs" with { type: "runtime" };`,
        `console.log(getTodos, jobs);`,
      ].join("\n"),
    );
    write("runtime/todos.fn.ts", todos);
    write("runtime/jobs.ts", todos.replace(`"todos"`, `"jobs"`));
    write("runtime/unused.fn.ts", todos.replace(`"todos"`, `"unused"`));

    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    expect(
      await compileInfra(path.join(root, "infra/main.ts"), { logger }),
    ).toEqual([
      path.join(root, "runtime/jobs.ts"),
      path.join(root, "runtime/todos.fn.ts"),
    ]);
    expect(logger.warn.mock.calls).toEqual([
      [
        expect.stringMatching(
          /^runtime\/unused\.fn\.ts matches runtimeModules and imports @notation\/aws\/lambda with \{ type: "infra" \}, but no infra module imports it with \{ type: "runtime" \}, so its functions aren't deployed\. To deploy them, import it from infra, as in `import \* as handlers from "\.\.\/runtime\/unused\.fn" with \{ type: "runtime" \};` in infra\/main\.ts/,
        ),
      ],
    ]);
  });

  it("fails with a migration message for a module that exports resource", async () => {
    write(
      "infra/main.ts",
      `import { getTodos } from "../runtime/todos.fn";\nconsole.log(getTodos);\n`,
    );
    write(
      "runtime/todos.fn.ts",
      `export const getTodos = () => [];\nexport const resource = { service: "aws/lambda", id: "todos" };`,
    );

    await expect(
      compileInfra(path.join(root, "infra/main.ts")),
    ).rejects.toThrow("runtime/todos.fn.ts exports `resource`");
  });

  it("keeps only the stripped copy of a runtime module in the infra bundle", async () => {
    write(
      "infra/main.ts",
      `import { getTodos } from "../runtime/todos.fn" with { type: "runtime" };\nconsole.log(getTodos);\n`,
    );
    write("runtime/todos.fn.ts", todos);

    await compileInfra(path.join(root, "infra/main.ts"));

    const bundle = readFileSync(path.join(root, "dist/infra/main.mjs"), "utf8");
    expect(bundle).toContain(`from "@notation/aws/lambda"`);
    expect(bundle).toContain(`lambda({ id: "todos", timeout: 5 })`);
    expect(bundle).toContain(`linkRuntimeModules`);
    expect(bundle).not.toContain("init");
  });
});
