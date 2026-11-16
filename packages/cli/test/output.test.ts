import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEventRenderer, resolveOutputMode } from "../src/output";

describe("resolveOutputMode", () => {
  it("follows the flag when it is given", () => {
    expect(resolveOutputMode({ json: true }, { isTTY: true })).toBe("json");
    expect(resolveOutputMode({ pretty: true }, { isTTY: false })).toBe(
      "pretty",
    );
  });

  it("is pretty on a terminal and JSON otherwise", () => {
    expect(resolveOutputMode({}, { isTTY: true }, {})).toBe("pretty");
    expect(resolveOutputMode({}, { isTTY: false }, {})).toBe("json");
    expect(resolveOutputMode({}, {}, {})).toBe("json");
  });

  it("is pretty in CI", () => {
    expect(resolveOutputMode({}, { isTTY: false }, { CI: "true" })).toBe(
      "pretty",
    );
    expect(resolveOutputMode({}, { isTTY: false }, { CI: "false" })).toBe(
      "json",
    );
    expect(resolveOutputMode({}, { isTTY: false }, { CI: "0" })).toBe("json");
  });
});

describe("createEventRenderer", () => {
  // FORCE_COLOR would add colour codes to the lines.
  beforeEach(() => vi.stubEnv("FORCE_COLOR", "0"));
  afterEach(() => vi.unstubAllEnvs());

  it("logs pretty lines at the event's level", async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const emit = createEventRenderer("pretty", logger);

    await emit({
      level: "warn",
      event: "reconciler.hold.waiting",
      deploymentId: "app:test",
      executionId: "exec-2",
      holderExecutionId: "exec-1",
    });

    expect(logger.warn).toHaveBeenCalledWith(
      "! waiting for execution exec-1, which holds app:test",
    );
  });
});
