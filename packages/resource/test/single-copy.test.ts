import { expect, it } from "vitest";
import { claimSingleCopy } from "src/resource-collection";

const loaded = (globalThis as Record<symbol, string>)[
  Symbol.for("@notation/resource/loaded")
]!;

it("records the copy that is loaded", () => {
  expect(loaded).toMatch(/resource-collection\.ts$/);
  expect(() => claimSingleCopy(loaded)).not.toThrow();
});

it("fails when another copy is loaded", () => {
  expect(() => claimSingleCopy("file:///other/resource-collection.js")).toThrow(
    `Two copies of @notation/resource are loaded, from ${loaded} and file:///other/resource-collection.js.`,
  );
});
