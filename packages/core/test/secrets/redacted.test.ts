import { inspect } from "node:util";
import { expect, it } from "vitest";
import { Redacted } from "src/secrets";

const value = new Redacted("sk_live_123");

it("returns the value from unwrap", () => {
  expect(value.unwrap()).toBe("sk_live_123");
});

it.each([
  ["a template literal", () => `Bearer ${value}`],
  ["String()", () => String(value)],
  ["concatenation", () => (value as unknown as string) + ""],
  ["JSON.stringify", () => JSON.stringify({ value })],
])("throws when it is turned into text with %s", (_, use) => {
  expect(use).toThrow("A Redacted value can't be");
});

it("prints a placeholder when it is inspected, alone or inside an error", () => {
  expect(inspect(value)).toBe("Redacted(<hidden>)");
  const error = Object.assign(new Error("failed"), { value });
  expect(inspect(error)).toContain("value: Redacted(<hidden>)");
  expect(inspect(error)).not.toContain("sk_live_123");
});

it("keeps the value out of the object's own keys", () => {
  expect(Object.keys(value)).toEqual([]);
  expect(inspect(value, { showHidden: true })).not.toContain("sk_live_123");
});
