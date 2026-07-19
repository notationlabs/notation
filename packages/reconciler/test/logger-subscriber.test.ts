import { describe, expect, it, vi } from "vitest";
import { createLoggerReconcilerSubscriber } from "../src";

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
      event: "reconciler.orphan-deletion.skipped",
      reason: "resource-type-not-registered",
      workflow: "deploy",
      resourceId: "resource-2",
      resourceType: "test/service/subscriber",
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

    expect(info).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledOnce();
  });
});
