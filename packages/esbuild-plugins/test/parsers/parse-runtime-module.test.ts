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

  it("fails for a config export whose type annotation hides the shape", () => {
    expect(() =>
      parse(
        `export const config: LambdaConfig = { service: "aws/lambda", id: "todos" };`,
      ),
    ).toThrow('rename the "config" export to "resource"');
  });

  it("treats a config export without a service as ordinary code", () => {
    expect(parse(`export const config = { region: "eu-west-1" };`)).toBe(
      undefined,
    );
    expect(parse(`export const config = loadConfig();`)).toBe(undefined);
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
      export declare namespace Ambient { const a: string; }
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
    [`export = {};`, /`export =` is not supported/],
    [`const a = 1; export { a as "a-b" };`, /string export names/],
    [`export * as "a-b" from "./utils";`, /string export names/],
    [
      `export const __notationResource = 1;`,
      /"__notationResource" is reserved/,
    ],
    [
      `const a = 1; export { a as __notationFactory };`,
      /"__notationFactory" is reserved/,
    ],
    [`export namespace Utils { export const a = 1; }`, /`export namespace`/],
    [`import fs = require("fs"); export import f = fs;`, /`export import`/],
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

  it("must have a supported service", () => {
    expect(() => parse(`export const resource = { id: "todos" };`)).toThrow(
      "todos.ts: `resource.service` is missing",
    );
    expect(() =>
      parse(`export const resource = { service: "lambda", id: "todos" };`),
    ).toThrow(
      'todos.ts: unsupported service "lambda" in `resource.service`. Supported services: "aws/lambda".',
    );
    expect(() =>
      parse(
        `export const resource = { service: "cloudflare/worker", id: "todos" };`,
      ),
    ).toThrow('unsupported service "cloudflare/worker"');
  });

  it("must have a string id", () => {
    expect(() =>
      parse(`export const resource = { service: "aws/lambda" };`),
    ).toThrow("todos.ts: `resource.id` is missing");
    expect(() =>
      parse(`export const resource = { service: "aws/lambda", id: 1 };`),
    ).toThrow("`resource.id` must be a string, not 1");
  });

  it.each([``, `todos.api`, `my todos`, `a`.repeat(65)])(
    "must have a name-safe id: %j",
    (id) => {
      expect(() =>
        parse(
          `export const resource = { service: "aws/lambda", id: "${id}" };`,
        ),
      ).toThrow(`todos.ts: \`resource.id\` "${id}" is not name-safe`);
    },
  );

  it("accepts a name-safe id of up to 64 characters", () => {
    const id = `A_b-${"c".repeat(60)}`;
    expect(
      parse(`export const resource = { service: "aws/lambda", id: "${id}" };`)
        ?.resource.id,
    ).toBe(id);
  });

  it("must not set code", () => {
    expect(() =>
      parse(
        `export const resource = { service: "aws/lambda", id: "todos", code: {} };`,
      ),
    ).toThrow("`resource.code` is set by the compiler");
  });
});
