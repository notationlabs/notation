import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { setConfigFile } from "@notation/core";
import { infraPlugin } from "src/plugins/infra-plugin";
import {
  buildVirtual,
  projectRoot,
  readVirtualFile,
} from "test/esbuild-test-utils";

beforeAll(() => setConfigFile(path.join(projectRoot, "notation.config.ts")));
afterAll(() => setConfigFile(undefined));

const buildInfra = (
  files: Record<string, string>,
  runtimeModules = ["**/*.fn.ts"],
) =>
  buildVirtual(files, "infra/main.ts", [
    infraPlugin({ runtimeModules, getFile: readVirtualFile(files) }),
  ]);

const todos = `
  import { handle } from "@notation/aws/lambda.fn";
  import { fetchTodos } from "./utils";

  console.log("init");
  const todos = await fetchTodos();

  export const getTodos = handle.apiRequest(() => todos);
  export async function createTodo() {}
  export type Todo = { id: string };
  export const resource = {
    service: "aws/lambda",
    id: "todos",
    timeout: 5,
    memory: 64,
  } satisfies LambdaResource;
`;

const utils = `export const fetchTodos = () => { console.log("fetching"); return []; };`;

it("replaces a runtime module with a module that declares its resource", async () => {
  const output = await buildInfra({
    "infra/main.ts": `import { getTodos, createTodo } from "../runtime/todos.fn"; console.log(getTodos, createTodo);`,
    "runtime/todos.fn.ts": todos,
    "runtime/utils.ts": utils,
  });

  expect(output).toContain(
    'import { lambda as __notationFactory } from "@notation/aws/lambda";',
  );
  expect(output).toContain(
    'var __notationResource = __notationFactory({ "id": "todos", "code": { "type": "file", "path": "dist/runtime/todos.fn/index.mjs" }, "timeout": 5, "memory": 64 });',
  );
  expect(output).toContain(
    'var __notationRef0 = { resource: __notationResource, export: "getTodos" };',
  );
  expect(output).toContain(
    'var __notationRef1 = { resource: __notationResource, export: "createTodo" };',
  );
});

it("keeps none of the runtime module's code", async () => {
  const output = await buildInfra({
    "infra/main.ts": `import { getTodos } from "../runtime/todos.fn"; console.log(getTodos);`,
    "runtime/todos.fn.ts": todos,
    "runtime/utils.ts": utils,
  });

  expect(output).not.toContain("init");
  expect(output).not.toContain("fetching");
  expect(output).not.toContain("@notation/aws/lambda.fn");
});

it("uses the configured globs", async () => {
  const files = {
    "infra/main.ts": `import { getTodos } from "../runtime/todos"; console.log(getTodos);`,
    "runtime/todos.ts": todos,
    "runtime/utils.ts": utils,
  };

  const output = await buildInfra(files, ["runtime/**"]);
  expect(output).toContain("dist/runtime/todos/index.mjs");

  const unmatched = await buildInfra(files, ["jobs/**"]);
  expect(unmatched).not.toContain("__notationFactory");
  expect(unmatched).toContain("init");
});

it("loads a matching module without a resource export as an ordinary module", async () => {
  const output = await buildInfra(
    {
      "infra/main.ts": `import { fetchTodos } from "../runtime/utils"; console.log(fetchTodos);`,
      "runtime/utils.ts": utils,
    },
    ["runtime/**"],
  );

  expect(output).toContain("fetching");
  expect(output).not.toContain("__notationFactory");
});

it("fails with a migration message for a config export", async () => {
  const build = buildInfra({
    "infra/main.ts": `import { getNum } from "../runtime/nums.fn"; console.log(getNum);`,
    "runtime/nums.fn.ts": `
      export const getNum = () => 1;
      export const config = { service: "aws/lambda", id: "nums" };
    `,
  });

  await expect(build).rejects.toThrow(
    /runtime\/nums\.fn\.ts: rename the "config" export to "resource"/,
  );
});

it("fails if the resource has no id", async () => {
  const build = buildInfra({
    "infra/main.ts": `import { getNum } from "../runtime/nums.fn"; console.log(getNum);`,
    "runtime/nums.fn.ts": `
      export const getNum = () => 1;
      export const resource = { service: "aws/lambda" };
    `,
  });

  await expect(build).rejects.toThrow(
    /runtime\/nums\.fn\.ts: `resource.id` is missing/,
  );
});
