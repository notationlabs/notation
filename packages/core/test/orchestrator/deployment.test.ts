import { collectResourceGraph } from "@notation/resource";
import { describe, expect, it } from "vitest";
import { deployment } from "src/orchestrator/graph";

describe("deployment", () => {
  it("returns the app and the stage while infra code is evaluated", async () => {
    let seen: unknown;
    await collectResourceGraph(
      () => {
        seen = deployment();
      },
      { scope: { app: "orders", stage: "prod" } },
    );
    expect(seen).toEqual({ app: "orders", stage: "prod" });
  });

  it("throws outside the evaluation of infra code", () => {
    expect(() => deployment()).toThrow(
      "deployment() can only be called while notation evaluates the infra code",
    );
  });
});
