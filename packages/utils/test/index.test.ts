import { describe, expect, it } from "vitest";
import { isErrorWithCode } from "../src";

describe("isErrorWithCode", () => {
  it("recognises an object with the requested code", () => {
    expect(isErrorWithCode({ code: "ENOENT" }, "ENOENT")).toBe(true);
  });

  it("rejects other codes and non-object values", () => {
    expect(isErrorWithCode({ code: "EEXIST" }, "ENOENT")).toBe(false);
    expect(isErrorWithCode("ENOENT", "ENOENT")).toBe(false);
  });
});
