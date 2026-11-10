import { expect, it } from "vitest";
import { collectResourceGraph, perCollection } from "src";

it("gives one value for each graph that is being collected", async () => {
  const store = perCollection("test/values", () => [] as string[]);
  const seen: string[][] = [];

  await collectResourceGraph(() => {
    store()!.push("a");
    store()!.push("b");
    seen.push(store()!);
  });
  await collectResourceGraph(() => {
    seen.push(store()!);
  });

  expect(seen).toEqual([["a", "b"], []]);
});

it("shares the value between two stores with the same key", async () => {
  const first = perCollection("test/shared", () => new Set<string>());
  const second = perCollection("test/shared", () => new Set<string>());

  await collectResourceGraph(() => {
    first()!.add("api");
    expect(second()!.has("api")).toBe(true);
  });
});

it("gives undefined when no graph is being collected", () => {
  expect(perCollection("test/outside", () => 1)()).toBeUndefined();
});
