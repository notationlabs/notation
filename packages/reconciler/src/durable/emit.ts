import type {
  OperationLifecycleEvent,
  OperationLifecycleStatus,
  OperationName,
  ReconcilerEventEmitter,
} from "../events";
import type { DurableStep } from "./yieldstar";

/** Checkpoints delivery after the emitter returns. Emitters must tolerate a duplicate if the process crashes before that checkpoint. */
export function emitEvent(
  step: DurableStep,
  key: string,
  emit: ReconcilerEventEmitter | undefined,
  event: () => Parameters<ReconcilerEventEmitter>[0],
) {
  return step.run(key, async () => {
    await emit?.(event());
  });
}

export function emitLifecycle(
  step: DurableStep,
  key: string,
  emit: ReconcilerEventEmitter | undefined,
  operation: OperationName,
  status: OperationLifecycleStatus,
  resource: LifecycleResource,
  extra: { reason?: string; error?: unknown } = {},
) {
  return emitEvent(step, key, emit, () =>
    createLifecycleEvent(operation, status, resource, extra),
  );
}

type LifecycleResource = {
  id: string;
  type: OperationLifecycleEvent["resourceType"];
};

export function createLifecycleEvent(
  operation: OperationName,
  status: OperationLifecycleStatus,
  resource: LifecycleResource,
  extra: { reason?: string; error?: unknown } = {},
): OperationLifecycleEvent {
  const error = extra.error;
  const details =
    error === undefined
      ? {}
      : error instanceof Error
        ? { errorName: error.name, errorMessage: error.message }
        : { errorName: "UnknownError", errorMessage: String(error) };

  return {
    level: status === "error" ? "error" : "info",
    event: "reconciler.operation.lifecycle",
    operation,
    status,
    resourceId: resource.id,
    resourceType: resource.type,
    ...(extra.reason ? { reason: extra.reason } : {}),
    ...details,
  };
}
