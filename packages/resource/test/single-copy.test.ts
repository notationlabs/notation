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
    `Two versions of @notation/resource were detected at ${loaded} and file:///other/resource-collection.js. Please install one version (for example with npm dedupe).`,
  );
});
