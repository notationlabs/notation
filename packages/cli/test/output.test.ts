import { describe, expect, it, vi } from "vitest";
import {
  createEventRenderer,
  formatPrettyEvent,
  resolveOutputMode,
} from "../src/output";

describe("resolveOutputMode", () => {
  it("follows the flag when it is given", () => {
    expect(resolveOutputMode({ json: true }, { isTTY: true })).toBe("json");
    expect(resolveOutputMode({ pretty: true }, { isTTY: false })).toBe(
      "pretty",
    );
  });

  it("is pretty on a terminal and JSON otherwise", () => {
    expect(resolveOutputMode({}, { isTTY: true })).toBe("pretty");
    expect(resolveOutputMode({}, { isTTY: false })).toBe("json");
    expect(resolveOutputMode({}, {})).toBe("json");
  });
});

describe("formatPrettyEvent", () => {
  const lifecycle = {
    level: "info",
    event: "reconciler.operation.lifecycle",
    operation: "delete",
    resourceId: "router-kv",
    resourceType: "cloudflare/kv/namespace",
  } as const;

  it("prints an operation as one line per status", () => {
    expect(formatPrettyEvent({ ...lifecycle, status: "start" })).toBe(
      "… delete router-kv cloudflare/kv/namespace",
    );
    expect(formatPrettyEvent({ ...lifecycle, status: "success" })).toBe(
      "✓ delete router-kv cloudflare/kv/namespace",
    );
  });

  it("names the credential of a rotate", () => {
    expect(
      formatPrettyEvent({
        ...lifecycle,
        operation: "rotate",
        credential: "Value",
        status: "success",
      }),
    ).toBe("✓ rotate Value of router-kv cloudflare/kv/namespace");
  });

  it("prints the error of a failed operation on the next line", () => {
    expect(
      formatPrettyEvent({
        ...lifecycle,
        level: "error",
        status: "error",
        errorName: "DeleteFailed",
        errorMessage: "boom",
      }),
    ).toBe(
      "✗ delete router-kv cloudflare/kv/namespace\n    DeleteFailed: boom",
    );
  });

  it("describes a create that took over a resource", () => {
    expect(
      formatPrettyEvent({
        ...lifecycle,
        operation: "create",
        status: "success",
        reason: "taken-over",
      }),
    ).toBe(
      "✓ create router-kv cloudflare/kv/namespace " +
        "(took over a resource that already existed)",
    );
  });

  it("leaves out noop decisions", () => {
    expect(
      formatPrettyEvent({
        level: "info",
        event: "reconciler.deploy.decision",
        decision: "noop",
        resourceId: "router-kv",
        resourceType: "cloudflare/kv/namespace",
      }),
    ).toBeUndefined();
  });

  it("names the fields and order of a replace", () => {
    expect(
      formatPrettyEvent({
        level: "info",
        event: "reconciler.deploy.decision",
        decision: "replace",
        replaceFields: [
          { name: "title", known: true },
          { name: "binding", known: false },
        ],
        replaceOrder: "create-first",
        resourceId: "router-kv",
        resourceType: "cloudflare/kv/namespace",
      }),
    ).toBe(
      "→ replace router-kv cloudflare/kv/namespace " +
        "(title, binding?; create, then delete)",
    );
  });
});

describe("a requested replace", () => {
  it("says that --replace asked for it", () => {
    expect(
      formatPrettyEvent({
        level: "info",
        event: "reconciler.deploy.decision",
        decision: "replace",
        replaceFields: [{ requested: true, known: true }],
        replaceOrder: "delete-first",
        resourceId: "bucket:uploads",
        resourceType: "cloudflare/r2/bucket",
      }),
    ).toBe(
      "→ replace bucket:uploads cloudflare/r2/bucket " +
        "(replaced by --replace; delete, then create)",
    );
  });
});

describe("createEventRenderer", () => {
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
