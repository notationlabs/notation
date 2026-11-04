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
    [`export default {};`, /unsupported export/],
    [`export default function () {}`, /unsupported export/],
    [`const a = 1; export { a as default };`, /unsupported export/],
    [`export * from "./utils";`, /unsupported export/],
    [`export const { a, b } = obj;`, /unsupported export/],
    [`export = {};`, /unsupported export/],
    [`const a = 1; export { a as "a-b" };`, /unsupported export/],
    [`export * as "a-b" from "./utils";`, /unsupported export/],
    [
      `export const __notationResource = 1;`,
      /"__notationResource" is reserved/,
    ],
    [
      `const a = 1; export { a as __notationFactory };`,
      /"__notationFactory" is reserved/,
    ],
    [`export namespace Utils { export const a = 1; }`, /unsupported export/],
    [`import fs = require("fs"); export import f = fs;`, /unsupported export/],
  ])("rejects %s", (source, message) => {
    expect(() => parse(`${source}\n${resource}`)).toThrow(message);
  });

  it("names the unsupported export and the supported forms", () => {
    expect(() => parse(`export default {};\n${resource}`)).toThrow(
      "todos.ts: unsupported export `export default {};`. A runtime module can use `export const`, `export function`, `export class`, `export enum`, `export { a, b }` and `export * as name from`, with identifier names.",
    );
  });
});

describe("resource", () => {
  it("reads literal values", () => {
    // The parser doesn't check value types, so `runtime` holds every kind of
    // literal here.
    const module = parse(`
      export const resource: LambdaResource = {
        service: "aws/lambda",
        id: \`todos\`,
        timeout: 5,
        runtime: ["a", { b: false, c: null, n: -1, "quoted-key": true }],
      } as const;
    `);

    expect(module?.resource).toEqual({
      service: "aws/lambda",
      id: "todos",
      timeout: 5,
      runtime: ["a", { b: false, c: null, n: -1, "quoted-key": true }],
    });
  });

  it("keeps a __proto__ key as a key", () => {
    const module = parse(`
      export const resource = {
        service: "aws/lambda",
        id: "todos",
        runtime: { __proto__: { polluted: true } },
      };
    `);
    const runtime = module?.resource.runtime as Record<string, unknown>;

    expect(Object.getPrototypeOf(runtime)).toBe(Object.prototype);
    expect(Object.keys(runtime)).toEqual(["__proto__"]);
  });

  it("rejects a key that the service does not have", () => {
    expect(() =>
      parse(
        `export const resource = { service: "aws/lambda", id: "todos", timout: 5 };`,
      ),
    ).toThrow(
      'todos.ts: unknown key `resource.timout` for "aws/lambda". Known keys: service, id, runtime, timeout, memory.',
    );
  });

  it.each([
    [`id`, "`resource.id` must be a literal value"],
    [`"todos", ...rest`, "`resource` must be a literal value"],
    [`"todos", memory`, "`resource` must be a literal value"],
    [
      `"todos", runtime: [name]`,
      "`resource.runtime[0]` must be a literal value",
    ],
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
