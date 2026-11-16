import { describe, expect, it } from "vitest";
import { jsonSchema } from "src/json";

const issuesOf = (value: unknown) => {
  const result = jsonSchema()["~standard"].validate(value) as {
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
    expect(issuesOf({ a: NaN, b: Infinity, c: -Infinity })).toEqual([
      "a: NaN isn't JSON. JSON.stringify writes it as null",
      "b: Infinity isn't JSON. JSON.stringify writes it as null",
      "c: -Infinity isn't JSON. JSON.stringify writes it as null",
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

  it("refuses a bigint and a symbol", () => {
    expect(issuesOf({ a: 1n, b: Symbol("b") })).toEqual([
      "a: A bigint isn't JSON",
      "b: A symbol isn't JSON",
    ]);
  });

  it("refuses a value whose encoded text is longer than 25 MiB in UTF-8", () => {
    const limit = 25 * 1024 * 1024;
    // The quotes add 2 bytes to the text.
    expect(issuesOf("a".repeat(limit - 2))).toEqual([]);
    expect(issuesOf("a".repeat(limit - 1))).toEqual([
      `: The JSON text is ${limit + 1} bytes, more than the limit of ${limit}`,
    ]);
  });
});
