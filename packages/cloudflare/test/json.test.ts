import { describe, expect, it } from "vitest";
import { jsonSchema } from "src/json";

const issuesOf = (value: unknown, options?: { maxBytes?: number }) => {
  const result = jsonSchema(options)["~standard"].validate(value) as {
    issues?: { message: string; path: string[] }[];
  };
  return (result.issues ?? []).map(
    (issue) => `${issue.path.join(".")}: ${issue.message}`,
  );
};

describe("jsonSchema", () => {
  it("accepts JSON values, and objects with no prototype", () => {
    const bare = Object.assign(Object.create(null), { a: 1 });
    for (const value of [
      null,
      true,
      0,
      -1.5,
      "",
      [],
      [1, "a", null, [{}]],
      { a: { b: [true] } },
      bare,
    ]) {
      expect(issuesOf(value)).toEqual([]);
    }
  });

  it("refuses the numbers that JSON.stringify changes", () => {
    expect(issuesOf({ a: NaN, b: Infinity, c: -Infinity, d: -0 })).toEqual([
      "a: NaN isn't JSON. JSON.stringify writes it as null",
      "b: Infinity isn't JSON. JSON.stringify writes it as null",
      "c: -Infinity isn't JSON. JSON.stringify writes it as null",
      "d: -0 isn't JSON. JSON.stringify writes it as 0",
    ]);
  });

  it("refuses undefined at any depth, in an object or an array", () => {
    expect(issuesOf({ a: { b: undefined } })).toEqual([
      "a.b: undefined isn't JSON. Leave the key out instead",
    ]);
    expect(issuesOf({ a: [1, undefined] })).toEqual([
      "a.1: undefined isn't JSON. JSON.stringify writes it as null in an array",
    ]);
  });

  it("refuses a sparse array", () => {
    // eslint-disable-next-line no-sparse-arrays
    expect(issuesOf([1, , 3])).toEqual([
      "1: A sparse array isn't JSON. JSON.stringify writes each hole as null",
    ]);
  });

  it("refuses an object that isn't plain, such as a Date with toJSON", () => {
    class Point {
      x = 1;
    }
    expect(issuesOf({ at: new Date(0), point: new Point() })).toEqual([
      "at: A Date isn't JSON. Only plain objects are",
      "point: A Point isn't JSON. Only plain objects are",
    ]);
    expect(issuesOf({ toJSON: () => "x" })).toEqual([
      "toJSON: A function isn't JSON",
    ]);
  });

  it("refuses a bigint, a symbol and symbol keys", () => {
    expect(
      issuesOf({ a: 1n, b: Symbol("b"), c: { [Symbol("c")]: 1 } }),
    ).toEqual([
      "a: A bigint isn't JSON",
      "b: A symbol isn't JSON",
      "c: An object with symbol keys isn't JSON",
    ]);
  });

  it("refuses a value that holds itself, and accepts one object in two places", () => {
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    expect(issuesOf({ loop })).toEqual([
      "loop.self: The value holds itself, so it isn't JSON",
    ]);

    const shared = { a: 1 };
    expect(issuesOf({ x: shared, y: shared })).toEqual([]);
  });

  it("refuses a value whose encoded text is longer than maxBytes in UTF-8", () => {
    // "é" is 2 bytes, and the quotes make 2 more.
    expect(issuesOf("éé", { maxBytes: 6 })).toEqual([]);
    expect(issuesOf("ééé", { maxBytes: 6 })).toEqual([
      ": The JSON text is 8 bytes, more than the limit of 6",
    ]);
  });
});
