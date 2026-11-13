import { describe, expect, it } from "vitest";
import { collectResourceGraph } from "@notation/resource";
import { $durableObject } from "src/workers";

// Stands in for classes that extend DurableObject.
class Counter {}
class Room {}

const collect = (evaluate: () => unknown) =>
  collectResourceGraph(evaluate, { scope: { app: "shop", stage: "dev" } });

describe("$durableObject", () => {
  it("fails for a class that isn't a name, which the infra build gives no name", () => {
    const unnamed = (() => () => {})();
    expect(() =>
      $durableObject({ id: "counters", class: unnamed as any }),
    ).toThrow(
      `$durableObject({ id: "counters" }) expects class to name a class that its module declares or imports`,
    );
  });

  it("fails for two namespaces with the same id", async () => {
    await expect(
      collect(() => {
        $durableObject({ id: "rooms", class: Room });
        $durableObject({ id: "rooms", class: Counter });
      }),
    ).rejects.toThrow(`Duplicate $durableObject id "rooms"`);
  });
});
