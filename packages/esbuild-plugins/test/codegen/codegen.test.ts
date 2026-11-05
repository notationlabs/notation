import { expect, it } from "vitest";
import { createResourceModule, createRuntimeEntry } from "src/codegen/codegen";

it("creates a resource module", () => {
  const source = createResourceModule(
    {
      resource: { service: "aws/lambda", id: "todos", timeout: 5 },
      exports: ["getTodos", "delete"],
    },
    "dist/runtime/todos/index.mjs",
  );

  expect(source).toBe(
    [
      `import { lambda as __notationFactory } from "@notation/aws/lambda";`,
      `const __notationResource = __notationFactory({"id":"todos","code":{"type":"file","path":"dist/runtime/todos/index.mjs"},"timeout":5});`,
      `const __notationRef0 = { resource: __notationResource, export: "getTodos" };`,
      `export { __notationRef0 as getTodos };`,
      `const __notationRef1 = { resource: __notationResource, export: "delete" };`,
      `export { __notationRef1 as delete };`,
      ``,
    ].join("\n"),
  );
});

it("creates a runtime entry that dispatches to the module's exports", () => {
  expect(createRuntimeEntry("/project/runtime/todos.ts", "aws/lambda")).toBe(
    [
      `import * as mod from "/project/runtime/todos.ts";`,
      `import { createDispatcher } from "@notation/aws/lambda/runtime";`,
      `export const handler = createDispatcher(mod);`,
      ``,
    ].join("\n"),
  );
});
