import { MemoryStateBackend } from "@notation/state";
import { describe, expect, it } from "vitest";
import { readStateSnapshot } from "./server.js";

describe("dashboard state", () => {
  it("reads state through the backend contract", async () => {
    const state = new MemoryStateBackend({
      service: {
        version: 1,
        id: "service",
        type: "test/service/main",
        provider: "test",
        config: {},
        params: {},
        output: { ready: true },
        lastOperation: "create",
        lastOperationAt: "2026-07-18T00:00:00.000Z",
      },
    });

    await expect(readStateSnapshot(state)).resolves.toMatchObject({
      service: {
        id: "service",
        version: 1,
        output: { ready: true },
      },
    });
  });

  it("keeps the retired instances of a record", async () => {
    const retired = [
      {
        config: {},
        params: { name: "orders-1a2b3c4d" },
        output: { arn: "arn:old" },
        dependsOn: [],
        retiredAt: "2026-11-13T00:00:00.000Z",
      },
    ];
    const state = new MemoryStateBackend({
      role: {
        version: 1,
        id: "role",
        type: "test/service/role",
        provider: "test",
        config: {},
        params: { name: "orders-5e6f7a8b" },
        output: { arn: "arn:new" },
        lastOperation: "create",
        lastOperationAt: "2026-11-13T00:00:01.000Z",
        retired,
      },
    });

    await expect(readStateSnapshot(state)).resolves.toMatchObject({
      role: { output: { arn: "arn:new" }, retired },
    });
  });
});
