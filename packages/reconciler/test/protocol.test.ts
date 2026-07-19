import { describe, expect, it } from "vitest";
import { createNdjsonEventEmitter } from "../src";

describe("event stream protocol", () => {
  it("writes one versioned JSON document per event", async () => {
    const lines: string[] = [];
    const emit = createNdjsonEventEmitter((line) => {
      lines.push(line);
    });
    await emit({
      level: "info",
      event: "reconciler.deploy.decision",
      resourceId: "service",
      resourceType: "test/service/main",
      decision: "create",
    });

    expect(lines).toHaveLength(1);
    expect(lines[0]?.endsWith("\n")).toBe(true);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      version: 1,
      decision: "create",
    });
  });
});
