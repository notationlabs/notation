import { expect, it } from "vitest";
import { createResourceModule, createRuntimeEntry } from "src/codegen/codegen";

it("creates a resource module", () => {
  const source = createResourceModule(
    {
      resource: {
        service: "aws/lambda",
        id: "todos",
        timeout: 5,
        tags: { "cost-centre": "a" },
      },
      exports: ["getTodos", "createTodo"],
    },
    "dist/runtime/todos/index.mjs",
  );

  expect(source).toBe(
    [
      `import { lambda as __notationFactory } from "@notation/aws/lambda";`,
      `const __notationResource = __notationFactory({ id: "todos", code: { type: "file", path: "dist/runtime/todos/index.mjs" }, timeout: 5, tags: { "cost-centre": "a" } });`,
      `export const getTodos = { resource: __notationResource, export: "getTodos" };`,
      `export const createTodo = { resource: __notationResource, export: "createTodo" };`,
      ``,
    ].join("\n"),
  );
});

it("exports a reference under a reserved word through an alias", () => {
  const source = createResourceModule(
    {
      resource: { service: "aws/lambda", id: "todos" },
      exports: ["getTodos", "delete"],
    },
    "dist/runtime/todos/index.mjs",
  );

  expect(source).toContain(
    `const __notationRef1 = { resource: __notationResource, export: "delete" };\nexport { __notationRef1 as delete };`,
  );
  expect(source).toContain(`export const getTodos = `);
});

it("creates a runtime entry that dispatches to the module's exports", () => {
  expect(createRuntimeEntry("/project/runtime/todos.ts", "aws/lambda")).toBe(
    [
      `import * as mod from "/project/runtime/todos.ts";`,
      `import { createDispatcher } from "@notation/aws/lambda.fn";`,
      `export const handler = createDispatcher(mod);`,
      ``,
    ].join("\n"),
  );
});
