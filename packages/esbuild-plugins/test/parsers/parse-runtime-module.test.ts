import { describe, expect, it } from "vitest";
import { parseRuntimeModule } from "src/parsers/parse-runtime-module";

const parse = (source: string) => parseRuntimeModule(source, "todos.ts");
const resource = `export const resource = { service: "aws/lambda", id: "todos" };`;

describe("detection", () => {
  it("returns undefined for a module without a resource export", () => {
    expect(parse(`export const fetchTodos = () => [];`)).toBeUndefined();
  });

  it("fails with a migration message for a config export", () => {
    expect(() =>
      parse(`export const config = { service: "aws/lambda", id: "todos" };`),
    ).toThrow('todos.ts: rename the "config" export to "resource"');
  });

  it("treats config as an ordinary export next to resource", () => {
    expect(parse(`export const config = 1;\n${resource}`)?.exports).toEqual([
      "config",
    ]);
  });
});

describe("exports", () => {
  it("lists value exports, without resource", () => {
    const module = parse(`
      const a = 1;
      const b = 2;
      export const getTodos = handle.apiRequest(() => []);
      export let count;
      export function createTodo() {}
      export async function deleteTodo() {}
      export class Store {}
      export enum Kind { A }
      export { a, b as renamed };
      export { shared } from "./shared";
      export * as utils from "./utils";
      ${resource}
    `);

    expect(module?.exports).toEqual([
      "getTodos",
      "count",
      "createTodo",
      "deleteTodo",
      "Store",
      "Kind",
      "a",
      "renamed",
      "shared",
      "utils",
    ]);
  });

  it("skips type exports", () => {
    const module = parse(`
      type Local = string;
      export type Todo = { id: string };
      export interface Store {}
      export const enum Kind { A }
      export type { Local };
      export { type Local as Other };
      export declare const injected: string;
      ${resource}
    `);

    expect(module?.exports).toEqual([]);
  });

  it.each([
    [`export default {};`, /default exports are not supported/],
    [`export default function () {}`, /default exports are not supported/],
    [
      `const a = 1; export { a as default };`,
      /default exports are not supported/,
    ],
    [`export * from "./utils";`, /`export \*` is not supported/],
    [`export const { a, b } = obj;`, /destructured exports are not supported/],
  ])("rejects %s", (source, message) => {
    expect(() => parse(`${source}\n${resource}`)).toThrow(message);
  });
});

describe("resource", () => {
  it("reads literal values", () => {
    const module = parse(`
      export const resource: LambdaResource = {
        service: "aws/lambda",
        id: \`todos\`,
        timeout: 5,
        offset: -1,
        enabled: true,
        layer: null,
        "quoted-key": "x",
        tags: ["a", { b: false }],
      } as const;
    `);

    expect(module?.resource).toEqual({
      service: "aws/lambda",
      id: "todos",
      timeout: 5,
      offset: -1,
      enabled: true,
      layer: null,
      "quoted-key": "x",
      tags: ["a", { b: false }],
    });
  });

  it.each([
    [`id`, "`resource.id` must be a literal value"],
    [`"todos", ...rest`, "`resource` must be a literal value"],
    [`"todos", memory`, "`resource` must be a literal value"],
    [`"todos", tags: [name]`, "`resource.tags[0]` must be a literal value"],
    [`"todos", timeout: 60 * 5`, "`resource.timeout` must be a literal value"],
  ])("rejects values that are not static: id: %s", (props, message) => {
    expect(() =>
      parse(`export const resource = { service: "aws/lambda", id: ${props} };`),
    ).toThrow(message);
  });

  it("must be an object literal", () => {
    expect(() => parse(`export const resource = makeResource();`)).toThrow(
      "todos.ts: `resource` must be an object literal",
    );
    expect(() => parse(`export function resource() {}`)).toThrow(
      "`resource` must be an object literal",
    );
    expect(() => parse(`const r = {}; export { r as resource };`)).toThrow(
      "`resource` must be declared with `export const resource",
    );
  });

  it("must have a service of the form <platform>/<service>", () => {
    expect(() => parse(`export const resource = { id: "todos" };`)).toThrow(
      "todos.ts: `resource.service` is missing",
    );
    expect(() =>
      parse(`export const resource = { service: "lambda", id: "todos" };`),
    ).toThrow('`resource.service` must be "<platform>/<service>"');
  });

  it("must have a string id", () => {
    expect(() =>
      parse(`export const resource = { service: "aws/lambda" };`),
    ).toThrow("todos.ts: `resource.id` is missing");
    expect(() =>
      parse(`export const resource = { service: "aws/lambda", id: 1 };`),
    ).toThrow("`resource.id` must be a string, not 1");
  });

  it("must not set code", () => {
    expect(() =>
      parse(
        `export const resource = { service: "aws/lambda", id: "todos", code: {} };`,
      ),
    ).toThrow("`resource.code` is set by the compiler");
  });
});
