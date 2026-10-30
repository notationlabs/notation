import { describe, expect, it } from "vitest";
import { sortedJson } from "../src";

describe("sortedJson", () => {
  it("encodes equal maps to the same string, whatever their key order", () => {
    const a = sortedJson.encode({ b: 1, a: { d: [2, 1], c: null } });
    const b = sortedJson.encode({ a: { c: null, d: [2, 1] }, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":{"c":null,"d":[2,1]},"b":1}');
  });

  it("keeps array order", () => {
    expect(sortedJson.encode([3, 1, 2])).toBe("[3,1,2]");
  });

  it("decodes what it encodes", () => {
    const value = { z: "x", a: [{ y: true, b: 2 }] };
    expect(sortedJson.decode(sortedJson.encode(value))).toEqual(value);
  });
});
