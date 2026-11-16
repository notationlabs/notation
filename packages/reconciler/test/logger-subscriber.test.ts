import { describe, expect, it, vi } from "vitest";
import { createLoggerReconcilerSubscriber, formatPrettyEvent } from "../src";

describe("logger reconciler subscriber", () => {
  it("routes info, warning, and error events to matching logger methods", async () => {
    const info = vi.fn();
    const warn = vi.fn();
    const error = vi.fn();

    const emit = createLoggerReconcilerSubscriber({
      logger: { info, warn, error },
    });

    await emit({
      level: "info",
      event: "reconciler.operation.lifecycle",
      operation: "create",
      status: "start",
      resourceId: "resource-1",
      resourceType: "test/service/subscriber",
    });
    await emit({
      level: "warn",
      event: "reconciler.hold.waiting",
      deploymentId: "deployment-1",
      executionId: "execution-2",
      holderExecutionId: "execution-1",
    });
    await emit({
      level: "error",
      event: "reconciler.operation.lifecycle",
      operation: "delete",
      status: "error",
      resourceId: "resource-3",
      resourceType: "test/service/subscriber",
      errorName: "DeleteFailed",
      errorMessage: "boom",
    });

    expect(info).toHaveBeenCalledWith(
      "… create resource-1 test/service/subscriber",
    );
    expect(warn).toHaveBeenCalledWith(
      "! waiting for execution execution-1, which holds deployment-1",
    );
    expect(error).toHaveBeenCalledWith(
      "✗ delete resource-3 test/service/subscriber\n    DeleteFailed: boom",
    );
  });

  it("applies the style it is given, and does not add a take-over line", async () => {
    const info = vi.fn();
    const emit = createLoggerReconcilerSubscriber({
      logger: { info, warn: vi.fn(), error: vi.fn() },
      style: (format, text, level) => `<${format} ${level}>${text}</${format}>`,
    });

    await emit({
      level: "info",
      event: "reconciler.operation.lifecycle",
      operation: "create",
      status: "success",
      reason: "taken-over",
      resourceId: "resource-1",
      resourceType: "test/service/subscriber",
    });

    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith(
      "<green info>✓</green> create resource-1 <dim info>test/service/subscriber</dim>" +
        "<dim info> (took over a resource that already existed)</dim>",
    );
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

  it("describes a credential passed with --credential", () => {
    expect(
      formatPrettyEvent({
        ...lifecycle,
        operation: "rotate",
        credential: "Value",
        status: "success",
        reason: "passed",
      }),
    ).toBe(
      "✓ rotate Value of router-kv cloudflare/kv/namespace " +
        "(passed with --credential)",
    );
  });

  it("puts a skip or dry run in the same details as the reason", () => {
    expect(
      formatPrettyEvent({ ...lifecycle, status: "skip", reason: "retired" }),
    ).toBe(
      "- delete router-kv cloudflare/kv/namespace " +
        "(the instance that a replace retired, skipped)",
    );
    expect(
      formatPrettyEvent({
        ...lifecycle,
        operation: "create",
        status: "dry-run",
        reason: "taken-over",
      }),
    ).toBe(
      "○ create router-kv cloudflare/kv/namespace " +
        "(took over a resource that already existed, dry run)",
    );
  });

  it("prints drift with the diff on the next line", () => {
    expect(
      formatPrettyEvent({
        level: "info",
        event: "reconciler.drift.detected",
        resourceId: "router-kv",
        resourceType: "cloudflare/kv/namespace",
        diff: { title: "old" },
      }),
    ).toBe('~ drift router-kv cloudflare/kv/namespace\n    {"title":"old"}');
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

  it("says that --replace asked for a replace", () => {
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

  it("prints a source warning", () => {
    expect(
      formatPrettyEvent({
        level: "warn",
        event: "reconciler.source.warning",
        resourceId: "router-kv",
        resourceType: "cloudflare/kv/namespace",
        message: "the value was empty",
      }),
    ).toBe("! router-kv cloudflare/kv/namespace the value was empty");
  });
});
