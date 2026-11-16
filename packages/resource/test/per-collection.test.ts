import { expect, it } from "vitest";
import {
  collectResourceGraph,
  evaluationEnded,
  onEvaluationEnd,
  perCollection,
} from "src";

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

it("reports that evaluation has ended once the onEvaluationEnd callbacks start", async () => {
  const seen: [string, boolean][] = [];
  await collectResourceGraph(async () => {
    seen.push(["evaluate", evaluationEnded()]);
    onEvaluationEnd(() => seen.push(["callback", evaluationEnded()]));
    await Promise.resolve();
    seen.push(["after an await", evaluationEnded()]);
  });
  seen.push(["after the collection", evaluationEnded()]);

  expect(seen).toEqual([
    ["evaluate", false],
    ["after an await", false],
    ["callback", true],
    ["after the collection", false],
  ]);
});

it("gives undefined when no graph is being collected", () => {
  expect(perCollection("test/outside", () => 1)()).toBeUndefined();
});
