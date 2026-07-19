import { MemoryStateBackend } from "@notation/state";
import { describe, expect, it } from "vitest";
import { readStateSnapshot } from "./server";

describe("dashboard state", () => {
  it("reads state through the backend contract", async () => {
    const state = new MemoryStateBackend();
    await state.update(
      "service",
      0,
      {
        id: "service",
        type: "test/service/main",
        config: {},
        params: {},
        output: { ready: true },
        lastOperation: "create",
        lastOperationAt: "2026-07-18T00:00:00.000Z",
      },
    );

    await expect(readStateSnapshot(state)).resolves.toMatchObject({
      service: {
        id: "service",
        rev: 1,
        output: { ready: true },
      },
    });
  });
});
